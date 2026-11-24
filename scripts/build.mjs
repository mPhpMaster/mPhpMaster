#!/usr/bin/env node
/**
 * Builds this profile.
 *
 * Reads profile.config.json, pulls live numbers from GitHub and Packagist, draws the
 * SVG cards in assets/ (a dark and a light copy of each), and refreshes the marked
 * parts of README.md. Run it with `node scripts/build.mjs`.
 *
 * No dependencies. Needs Node 18 or newer and a GitHub token: GITHUB_TOKEN or GH_TOKEN,
 * or a logged-in `gh` CLI.
 */

import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(join(ROOT, 'profile.config.json'), 'utf8'));
const RAW = `https://raw.githubusercontent.com/${config.login}/${config.login}/${config.branch}`;
const USER_AGENT = 'profile-readme-builder';

// ---------------------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------------------

const QUERY = `
query ($login: String!, $after: String) {
  user(login: $login) {
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount } }
      }
    }
    repositories(first: 100, after: $after, ownerAffiliations: OWNER, isFork: false, privacy: PUBLIC) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name
        url
        stargazerCount
        createdAt
        pushedAt
        primaryLanguage { name color }
        languages(first: 10, orderBy: { field: SIZE, direction: DESC }) { edges { size node { name color } } }
        latestRelease { tagName }
      }
    }
  }
}`;

function githubToken() {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    return execSync('gh auth token', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    throw new Error('No GitHub token found. Set GITHUB_TOKEN, or log in with `gh auth login`.');
  }
}

async function fetchGithub() {
  const token = githubToken();
  const repos = [];
  let calendar;
  let after = null;
  do {
    const response = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: { authorization: `bearer ${token}`, 'content-type': 'application/json', 'user-agent': USER_AGENT },
      body: JSON.stringify({ query: QUERY, variables: { login: config.login, after } }),
    });
    const body = await response.json();
    if (!response.ok || body.errors) {
      throw new Error(`GitHub API failed (${response.status}): ${JSON.stringify(body.errors ?? body)}`);
    }
    const { contributionsCollection, repositories } = body.data.user;
    calendar = contributionsCollection.contributionCalendar;
    repos.push(...repositories.nodes);
    after = repositories.pageInfo.hasNextPage ? repositories.pageInfo.endCursor : null;
  } while (after);
  return { calendar, repos };
}

/** Total installs per Composer package, keyed by lower-case package name. */
async function fetchPackagist(vendors) {
  const get = async (url) => {
    const response = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
    if (!response.ok) throw new Error(`Packagist failed (${response.status}): ${url}`);
    return response.json();
  };
  const lists = await Promise.all(vendors.map((vendor) => get(`https://packagist.org/packages/list.json?vendor=${vendor}`)));
  const names = lists.flatMap((list) => list.packageNames);
  const installs = {};
  for (let i = 0; i < names.length; i += 6) {
    await Promise.all(names.slice(i, i + 6).map(async (name) => {
      const { package: pkg } = await get(`https://packagist.org/packages/${name}.json`);
      // An abandoned package has been replaced by another one in the list, so skip it.
      if (!pkg.abandoned) installs[name.toLowerCase()] = pkg.downloads.total;
    }));
  }
  return installs;
}

function languageShares(repos, keep) {
  const byName = new Map();
  for (const repo of repos) {
    for (const { size, node } of repo.languages.edges) {
      const entry = byName.get(node.name) ?? { name: node.name, color: node.color ?? '#8b949e', size: 0 };
      entry.size += size;
      byName.set(node.name, entry);
    }
  }
  const all = [...byName.values()].sort((a, b) => b.size - a.size);
  const total = all.reduce((sum, language) => sum + language.size, 0) || 1;
  const top = all.slice(0, keep).map((language) => ({ ...language, share: language.size / total }));
  return { top, rest: Math.max(0, 1 - top.reduce((sum, language) => sum + language.share, 0)) };
}

// ---------------------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------------------

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace";
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const THEMES = {
  dark: {
    bg: '#10151C', bgEnd: '#0B0F14', border: '#272E38', track: '#1E252E',
    text: '#F0F3F6', muted: '#9BA5B1', faint: '#7D8794',
    accent: '#FFB454', hot: '#FF6A45', warm: '#FFB454', glow: 0.2,
  },
  light: {
    bg: '#FFFCF7', bgEnd: '#FFF6E9', border: '#EBDFCB', track: '#EFE4D1',
    text: '#1B1F24', muted: '#5A636E', faint: '#6B737E',
    accent: '#B4530A', hot: '#E5482A', warm: '#F5A524', glow: 0.16,
  },
};

const esc = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (value) => +value.toFixed(2);
const full = (value) => value.toLocaleString('en-US');
const compact = (value) => {
  if (value < 1000) return String(value);
  if (value < 10000) return `${(Math.floor(value / 100) / 10).toFixed(1).replace(/\.0$/, '')}k`;
  return `${Math.round(value / 1000)}k`;
};

/**
 * Rough text width in px. The cards use the reader's system font, so this is an estimate
 * and every layout that depends on it leaves room to spare.
 */
function textWidth(text, size, { bold = false, mono = false } = {}) {
  if (mono) return text.length * size * 0.61;
  let em = 0;
  for (const ch of text) {
    if (" .,:;|!'ijl".includes(ch)) em += 0.27;
    else if ('ftrI()[]-/'.includes(ch)) em += 0.34;
    else if ('mw'.includes(ch)) em += 0.82;
    else if ('MW'.includes(ch)) em += 0.9;
    else if (ch >= 'A' && ch <= 'Z') em += 0.66;
    else if (ch >= '0' && ch <= '9') em += 0.56;
    else em += 0.54;
  }
  return em * size * (bold ? 1.07 : 1);
}

function wrap(text, width, size, maxLines) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && textWidth(next, size) > width) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;

  lines.length = maxLines;
  let last = lines[maxLines - 1];
  while (last.includes(' ') && textWidth(`${last}…`, size) > width) last = last.slice(0, last.lastIndexOf(' '));
  lines[maxLines - 1] = `${last.replace(/[.,;:]$/, '')}…`;
  return lines;
}

const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const luminance = (hex) => {
  const [r, g, b] = channels(hex).map((c) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** Some language colours (PowerShell, Lua) are nearly black. Lift them until they show on a dark card. */
function languageColor(hex, themeName) {
  if (themeName !== 'dark' || !/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  let color = hex;
  for (let mix = 0.1; luminance(color) < 0.13 && mix < 0.95; mix += 0.1) {
    color = `#${channels(hex).map((c) => Math.round(c + (255 - c) * mix).toString(16).padStart(2, '0')).join('')}`;
  }
  return color;
}

function starPoints(cx, cy, outer = 5.6, inner = 2.4) {
  return Array.from({ length: 10 }, (_, i) => {
    const angle = (-90 + i * 36) * (Math.PI / 180);
    const radius = i % 2 ? inner : outer;
    return `${num(cx + radius * Math.cos(angle))},${num(cy + radius * Math.sin(angle))}`;
  }).join(' ');
}

/** The shared card: a rounded panel with the theme's text styles. */
function svg(width, height, theme, label, body, { defs = '', css = '' } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}">
<title>${esc(label)}</title>
<style>
text{font-family:${SANS};fill:${theme.text}}
.mono{font-family:${MONO}}
.muted{fill:${theme.muted}}
.faint{fill:${theme.faint}}
.accent{fill:${theme.accent}}
${css}</style>
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${theme.bg}"/><stop offset="1" stop-color="${theme.bgEnd}"/></linearGradient>
<clipPath id="panel"><rect x=".5" y=".5" width="${width - 1}" height="${height - 1}" rx="12"/></clipPath>
${defs}</defs>
<rect x=".5" y=".5" width="${width - 1}" height="${height - 1}" rx="12" fill="url(#bg)" stroke="${theme.border}"/>
${body}
</svg>
`;
}

const eyebrow = (text, x, y) =>
  `<text class="mono accent" x="${x}" y="${y}" font-size="10.5" letter-spacing="1.3">${esc(text.toUpperCase())}</text>`;

// ---------------------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------------------

/** Name, tagline, and a bar for each of the last 53 weeks of contributions. */
function heroCard(theme, { weeks, total }) {
  const W = 830, H = 300, PAD = 40;
  const top = 164, base = 258;
  const pitch = (W - PAD * 2) / weeks.length;
  const barWidth = Math.round(pitch * 0.66);
  const peak = Math.max(1, ...weeks.map((week) => week.total));
  const barX = (i) => PAD + i * pitch + (pitch - barWidth) / 2;

  const bars = weeks.map((week, i) => {
    // Square-root scale, so quiet weeks still show next to the busiest one.
    const height = week.total ? Math.max(3, Math.sqrt(week.total / peak) * (base - top)) : 2;
    const radius = Math.min(3, height, barWidth / 2);
    const x = barX(i), y = base - height;
    const d = `M${num(x)} ${base}V${num(y + radius)}Q${num(x)} ${num(y)} ${num(x + radius)} ${num(y)}`
      + `H${num(x + barWidth - radius)}Q${num(x + barWidth)} ${num(y)} ${num(x + barWidth)} ${num(y + radius)}V${base}Z`;
    // The current week is still filling up, so draw it lighter than the finished ones.
    const unfinished = i === weeks.length - 1 && week.days.length < 7;
    return `<path class="bar" style="animation-delay:${i * 14}ms" d="${d}" fill="${week.total ? 'url(#heat)' : theme.track}"${unfinished ? ' opacity=".5"' : ''}/>`;
  });

  let lastTick = -Infinity;
  const ticks = weeks.flatMap((week, i) => {
    const firstOfMonth = week.days.find((day) => day.endsWith('-01'));
    const x = barX(i);
    if (!firstOfMonth || x - lastTick < 30 || x > W - PAD - 20) return [];
    lastTick = x;
    return `<text class="mono faint" x="${num(x)}" y="${base + 20}" font-size="10.5">${MONTHS[+firstOfMonth.slice(5, 7) - 1]}</text>`;
  });

  const body = `<ellipse cx="${num(W * 0.8)}" cy="${base}" rx="320" ry="150" fill="url(#glow)" clip-path="url(#panel)"/>
<text class="mono accent" x="${PAD}" y="52" font-size="12" letter-spacing="1.6">${esc(config.eyebrow.toUpperCase())}</text>
<text x="${PAD}" y="100" font-size="42" font-weight="800" letter-spacing="-.8">${esc(config.name)}</text>
<text class="muted" x="${PAD}" y="130" font-size="17">${esc(config.tagline)}</text>
<text x="${W - PAD}" y="80" font-size="32" font-weight="800" text-anchor="end">${full(total)}</text>
<text class="mono muted" x="${W - PAD}" y="100" font-size="11.5" text-anchor="end">contributions · last 12 months</text>
${bars.join('\n')}
<path d="M${PAD} ${base + 0.5}H${W - PAD}" stroke="${theme.border}"/>
${ticks.join('\n')}`;

  const defs = `<linearGradient id="heat" gradientUnits="userSpaceOnUse" x1="0" y1="${top}" x2="0" y2="${base}"><stop offset="0" stop-color="${theme.hot}"/><stop offset="1" stop-color="${theme.warm}"/></linearGradient>
<radialGradient id="glow"><stop offset="0" stop-color="${theme.hot}" stop-opacity="${theme.glow}"/><stop offset="1" stop-color="${theme.hot}" stop-opacity="0"/></radialGradient>
`;
  const css = `@media (prefers-reduced-motion:no-preference){
.bar{transform-box:fill-box;transform-origin:50% 100%;animation:rise .8s cubic-bezier(.2,.9,.25,1) both}
@keyframes rise{from{transform:scaleY(0)}}
}
`;
  return svg(W, H, theme, `${config.name}. ${full(total)} contributions in the last 12 months.`, body, { defs, css });
}

function projectCard(theme, themeName, project) {
  const W = 412, H = 142, PAD = 22;
  const footY = H - 20;
  const lines = wrap(project.text, (W - PAD * 2) * 0.96, 13, 2);

  const foot = [];
  let x = PAD;
  if (project.language) {
    foot.push(`<circle cx="${x + 5}" cy="${footY - 4}" r="5" fill="${languageColor(project.language.color ?? '#8b949e', themeName)}"/>`);
    foot.push(`<text class="muted" x="${x + 16}" y="${footY}" font-size="12">${esc(project.language.name)}</text>`);
    x += 16 + textWidth(project.language.name, 12) + 16;
  }
  if (project.stars > 0) {
    foot.push(`<polygon points="${starPoints(x + 6, footY - 4.5)}" fill="${theme.muted}"/>`);
    foot.push(`<text class="muted" x="${x + 16}" y="${footY}" font-size="12">${full(project.stars)}</text>`);
  }
  const fresh = [project.release, project.pushed].filter(Boolean).join(' · ');
  foot.push(`<text class="mono faint" x="${W - PAD}" y="${footY}" font-size="10.5" text-anchor="end">${esc(fresh)}</text>`);

  const body = `${eyebrow(project.tag, PAD, 34)}
<path d="M${W - PAD - 9} 35l9-9m-6 0h6v6" fill="none" stroke="${theme.faint}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
<text x="${PAD}" y="60" font-size="17.5" font-weight="700">${esc(project.title)}</text>
${lines.map((line, i) => `<text class="muted" x="${PAD}" y="${82 + i * 18}" font-size="13">${esc(line)}</text>`).join('\n')}
${foot.join('\n')}`;
  return svg(W, H, theme, `${project.title}: ${project.text}`, body);
}

function numbersCard(theme, stats) {
  const W = 412, H = 170, PAD = 22;
  const cells = [
    [full(stats.repos), 'public projects'],
    [full(stats.started), 'started in the last year'],
    [full(stats.packages), 'Composer packages'],
    [compact(stats.installs), 'Packagist installs'],
  ];
  const body = `${eyebrow('Open source', PAD, 34)}
${cells.map(([figure, label], i) => {
    const x = PAD + (i % 2) * 190, y = 80 + Math.floor(i / 2) * 56;
    return `<text x="${x}" y="${y}" font-size="25" font-weight="800">${figure}</text>\n<text class="muted" x="${x}" y="${y + 18}" font-size="12">${label}</text>`;
  }).join('\n')}`;
  return svg(W, H, theme, cells.map(([figure, label]) => `${figure} ${label}`).join(', '), body);
}

function languagesCard(theme, themeName, { top, rest }, repoCount) {
  const W = 412, H = 170, PAD = 22, GAP = 2;
  const barWidth = W - PAD * 2;
  const segments = [...top.map((language) => ({ share: language.share, color: languageColor(language.color, themeName) }))];
  if (rest > 0.002) segments.push({ share: rest, color: theme.track });

  let x = PAD;
  const bar = segments.map((segment) => {
    const width = segment.share * barWidth;
    const rect = `<rect x="${num(x)}" y="50" width="${num(Math.max(0, width - GAP))}" height="10" fill="${segment.color}"/>`;
    x += width;
    return rect;
  });

  const legend = top.map((language, i) => {
    const lx = PAD + (i % 2) * 194, ly = 96 + Math.floor(i / 2) * 25;
    return `<circle cx="${lx + 5}" cy="${ly - 4}" r="5" fill="${languageColor(language.color, themeName)}"/>
<text x="${lx + 16}" y="${ly}" font-size="12.5">${esc(language.name)}</text>
<text class="mono muted" x="${lx + 174}" y="${ly}" font-size="11.5" text-anchor="end">${(language.share * 100).toFixed(1)}%</text>`;
  });

  const body = `${eyebrow('Languages', PAD, 34)}
<text class="mono faint" x="${W - PAD}" y="34" font-size="10.5" text-anchor="end">by code size · ${repoCount} repos</text>
<g clip-path="url(#bar)">${bar.join('')}</g>
${legend.join('\n')}`;
  const defs = `<clipPath id="bar"><rect x="${PAD}" y="50" width="${barWidth}" height="10" rx="5"/></clipPath>\n`;
  const label = `Languages by code size: ${top.map((language) => `${language.name} ${(language.share * 100).toFixed(1)}%`).join(', ')}`;
  return svg(W, H, theme, label, body, { defs });
}

// ---------------------------------------------------------------------------------------
// README
// ---------------------------------------------------------------------------------------

/** Replaces what sits between `<!-- name:start -->` and `<!-- name:end -->`. */
function replaceRegion(readme, name, content) {
  const pattern = new RegExp(`(<!-- ${name}:start -->)[\\s\\S]*?(<!-- ${name}:end -->)`);
  if (!pattern.test(readme)) throw new Error(`README.md has no "${name}" region to fill.`);
  return readme.replace(pattern, (_, start, end) => `${start}\n${content}\n${end}`);
}

/** Refreshes every `<!--stat:key-->value<!--/stat-->` span. */
function replaceStats(readme, values) {
  return readme.replace(/<!--stat:(.+?)-->[^<]*<!--\/stat-->/g, (_, key) => {
    if (!(key in values)) throw new Error(`README.md asks for an unknown stat: "${key}".`);
    return `<!--stat:${key}-->${values[key]}<!--/stat-->`;
  });
}

const themedImage = (path, width, alt) =>
  `<picture><source media="(prefers-color-scheme: dark)" srcset="${RAW}/${path}-dark.svg"><img src="${RAW}/${path}-light.svg" width="${width}" alt="${esc(alt)}"></picture>`;

// ---------------------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------------------

async function main() {
  const [{ calendar, repos }, installs] = await Promise.all([fetchGithub(), fetchPackagist(config.packagistVendors)]);

  const weeks = calendar.weeks.map((week) => ({
    total: week.contributionDays.reduce((sum, day) => sum + day.contributionCount, 0),
    days: week.contributionDays.map((day) => day.date),
  }));
  const yearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
  const stats = {
    contributions: calendar.totalContributions,
    repos: repos.length,
    stars: repos.reduce((sum, repo) => sum + repo.stargazerCount, 0),
    started: repos.filter((repo) => Date.parse(repo.createdAt) >= yearAgo).length,
    packages: Object.keys(installs).length,
    installs: Object.values(installs).reduce((sum, count) => sum + count, 0),
  };
  const languages = languageShares(repos, 6);

  const featured = config.featured.map((entry) => {
    const repo = repos.find((candidate) => candidate.name.toLowerCase() === entry.repo.toLowerCase());
    if (!repo) throw new Error(`Featured repo "${entry.repo}" is not one of ${config.login}'s public, non-fork repos.`);
    const pushed = new Date(repo.pushedAt);
    const version = repo.latestRelease?.tagName.match(/\d+(\.\d+)+.*/);
    return {
      ...entry,
      url: repo.url,
      stars: repo.stargazerCount,
      language: repo.primaryLanguage,
      release: version ? `v${version[0]}` : null,
      pushed: `${MONTHS[pushed.getUTCMonth()]} ${pushed.getUTCFullYear()}`,
    };
  });

  // Everything is fetched and checked by now, so a failure above leaves the old files untouched.
  const files = {};
  for (const [themeName, theme] of Object.entries(THEMES)) {
    files[`assets/hero-${themeName}.svg`] = heroCard(theme, { weeks, total: stats.contributions });
    files[`assets/numbers-${themeName}.svg`] = numbersCard(theme, stats);
    files[`assets/languages-${themeName}.svg`] = languagesCard(theme, themeName, languages, stats.repos);
    for (const project of featured) {
      files[`assets/cards/${project.repo}-${themeName}.svg`] = projectCard(theme, themeName, project);
    }
  }

  const statValues = {
    contributions: full(stats.contributions),
    repos: full(stats.repos),
    stars: full(stats.stars),
    packages: full(stats.packages),
    installs: compact(stats.installs),
    ...Object.fromEntries(Object.entries(installs).map(([name, count]) => [`installs:${name}`, compact(count)])),
  };
  const featuredHtml = `<p align="center">\n${featured
    .map((project) => `<a href="${project.url}">${themedImage(`assets/cards/${project.repo}`, 412, `${project.title}: ${project.text}`)}</a>`)
    .join('\n')}\n</p>`;

  let readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  readme = replaceRegion(readme, 'featured', featuredHtml);
  readme = replaceStats(readme, statValues);
  files['README.md'] = readme;

  rmSync(join(ROOT, 'assets/cards'), { recursive: true, force: true });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(ROOT, path)), { recursive: true });
    writeFileSync(join(ROOT, path), content);
  }
  console.log(`Built ${Object.keys(files).length} files:`, JSON.stringify(stats));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
