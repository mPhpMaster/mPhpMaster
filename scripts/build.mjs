#!/usr/bin/env node
/**
 * Builds this profile.
 *
 * Reads profile.config.json, pulls live numbers from GitHub and Packagist, draws the
 * terminal and the showcase cards in assets/, and refreshes the marked parts of
 * README.md. Run it with `node scripts/build.mjs`.
 *
 * No dependencies. Needs Node 18 or newer and a GitHub token: GITHUB_TOKEN or GH_TOKEN,
 * or a logged-in `gh` CLI.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
        primaryLanguage { name color }
        latestRelease { tagName publishedAt url }
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

/**
 * The row of language and tool icons, drawn by skillicons.dev. It only changes when the
 * list in the config does, so the copy in assets/ is reused until then.
 */
async function toolboxIcons(path) {
  const ids = Object.keys(config.icons);
  const marker = `<!-- icons:${ids.join(',')} per-line:${config.iconsPerLine} -->`;
  if (existsSync(path)) {
    const current = readFileSync(path, 'utf8');
    if (current.includes(marker)) return current;
  }
  const url = `https://skillicons.dev/icons?i=${ids.join(',')}&theme=dark&perline=${config.iconsPerLine}`;
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
  if (!response.ok) throw new Error(`Icon service failed (${response.status}): ${url}`);
  const svg = (await response.text()).trim();
  const drawn = (svg.match(/<g transform="translate\(/g) ?? []).length;
  if (!svg.startsWith('<svg') || /<script|<foreignObject|\son\w+\s*=|javascript:|href\s*=\s*["']https?:/i.test(svg)) {
    throw new Error('The icon service returned something that is not a plain SVG.');
  }
  if (drawn !== ids.length) {
    throw new Error(`The icon service drew ${drawn} of ${ids.length} icons. Check the ids under "icons" in profile.config.json.`);
  }
  return `${svg}\n${marker}\n`;
}

// ---------------------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------------------

const MONO = "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace";

// One dark terminal palette for both GitHub themes: a terminal window is dark either way.
const C = {
  window: '#010409', chrome: '#161b22', border: '#30363d', track: '#21262d',
  text: '#e6edf3', soft: '#c9d1d9', muted: '#8b949e',
  green: '#3fb950', blue: '#58a6ff', amber: '#e3b341',
  heat: ['#196c2e', '#2ea043', '#3fb950', '#56d364'],
  dots: ['#ff5f56', '#ffbd2e', '#27c93f'],
};

const esc = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (value) => +value.toFixed(2);
const full = (value) => value.toLocaleString('en-US');
const compact = (value) => {
  if (value < 1000) return String(value);
  if (value < 10000) return `${(Math.floor(value / 100) / 10).toFixed(1).replace(/\.0$/, '')}k`;
  return `${Math.round(value / 1000)}k`;
};

/** Wraps text to a number of monospace columns. */
function wrapColumns(text, columns, maxLines = Infinity) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && next.length > columns) {
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
  while (last.includes(' ') && last.length + 1 > columns) last = last.slice(0, last.lastIndexOf(' '));
  lines[maxLines - 1] = `${last.replace(/[.,;:]$/, '')}…`;
  return lines;
}

const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const luminance = (hex) => {
  const [r, g, b] = channels(hex).map((c) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** Some language colours (PowerShell, Lua) are nearly black. Lift them until they show on a dark card. */
function onDark(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex ?? '')) return C.muted;
  let color = hex;
  for (let mix = 0.1; luminance(color) < 0.13 && mix < 0.95; mix += 0.1) {
    color = `#${channels(hex).map((c) => Math.round(c + (255 - c) * mix).toString(16).padStart(2, '0')).join('')}`;
  }
  return color;
}

function starPoints(cx, cy, outer = 5, inner = 2.1) {
  return Array.from({ length: 10 }, (_, i) => {
    const angle = (-90 + i * 36) * (Math.PI / 180);
    const radius = i % 2 ? inner : outer;
    return `${num(cx + radius * Math.cos(angle))},${num(cy + radius * Math.sin(angle))}`;
  }).join(' ');
}

/** A terminal window: rounded frame, title bar with the three dots, and a centred title. */
function terminalWindow(width, height, barHeight, title, label, body, css = '') {
  const large = barHeight > 30;
  const dot = barHeight / 2;
  const radius = large ? 6 : 3.5;
  const gap = large ? 18 : 12;
  // On a small window the title is centred in the space left of the dots, so long names clear them.
  const dotsEnd = dot + 1 + gap * 2 + radius;
  const titleX = large ? width / 2 : (dotsEnd + width) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}">
<title>${esc(label)}</title>
<style>
text{font-family:${MONO}}
${css}</style>
<defs><clipPath id="frame"><rect x=".5" y=".5" width="${width - 1}" height="${height - 1}" rx="10"/></clipPath></defs>
<g clip-path="url(#frame)">
<rect width="${width}" height="${height}" fill="${C.window}"/>
<rect width="${width}" height="${barHeight}" fill="${C.chrome}"/>
<path d="M0 ${barHeight + 0.5}H${width}" stroke="${C.border}"/>
${C.dots.map((fill, i) => `<circle cx="${dot + 1 + i * gap}" cy="${dot}" r="${radius}" fill="${fill}"/>`).join('')}
<text x="${num(titleX)}" y="${num(dot + (large ? 4.5 : 4))}" font-size="${large ? 12.5 : 11}" fill="${C.muted}" text-anchor="middle">${esc(title)}</text>
${body}
</g>
<rect x=".5" y=".5" width="${width - 1}" height="${height - 1}" rx="10" fill="none" stroke="${C.border}"/>
</svg>
`;
}

// ---------------------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------------------

/**
 * The hero: a shell session that types itself. Every piece of text is pinned to a
 * character grid with textLength, so the layout and the typing stay exact whichever
 * monospace font the reader has.
 *
 * It is drawn twice: wide for desktop, and narrow with a short prompt for phones, where
 * fewer columns mean larger letters. Lines that do not fit the narrow window wrap.
 */
function terminalCard({ weeks, stats }, { cols: COLS, shell }) {
  const CW = 9, LH = 24, PAD_X = 24, PAD_Y = 20, BAR = 38;
  const W = PAD_X * 2 + COLS * CW;
  const promptParts = [[shell, C.green], [':', C.text], ['~', C.blue], ['$', C.text]];
  const promptCols = shell.length + 4;

  const parts = [];
  let row = 0;
  let clock = 0.5; // seconds from load: when the next thing appears

  const x = (col) => PAD_X + col * CW;
  const top = (r) => BAR + PAD_Y + r * LH;
  const delay = (seconds) => `animation-delay:${num(seconds)}s`;
  const text = (col, r, value, { fill = C.soft, bold = false, cls = 'o', style = '' } = {}) =>
    `<text x="${x(col)}" y="${top(r) + 17}" textLength="${value.length * CW}" fill="${fill}"${bold ? ' font-weight="700"' : ''} class="${cls}" style="${style}">${esc(value)}</text>`;

  const prompt = () => {
    let col = 0;
    for (const [value, fill] of promptParts) {
      parts.push(text(col, row, value, { fill, style: delay(clock) }));
      col += value.length;
    }
  };

  /** A prompt, then the command typed one character at a time behind a moving caret. */
  const command = (value) => {
    prompt();
    const start = clock + 0.3;
    const duration = value.length * 0.055;
    const typing = `--w:${value.length * CW}px;${delay(start)};animation-duration:${num(duration)}s;animation-timing-function:steps(${value.length},end)`;
    parts.push(`<text x="${x(promptCols)}" y="${top(row) + 17}" textLength="${value.length * CW}" fill="${C.text}">${esc(value)}</text>`);
    // The curtain hides what is not typed yet; the caret rides its left edge.
    parts.push(`<rect class="m" x="${x(promptCols)}" y="${top(row)}" width="${value.length * CW}" height="${LH}" fill="${C.window}" style="${typing}"/>`);
    parts.push(`<rect class="k" x="${x(promptCols)}" y="${top(row) + 3}" width="${CW}" height="18" fill="${C.soft}" style="${typing}"/>`);
    row += 1;
    clock = start + duration + 0.25;
  };

  /** One line of output made of [text, options] pieces placed one after another. */
  const output = (pieces) => {
    let col = 0;
    for (const [value, options = {}] of pieces) {
      parts.push(text(col + (options.skip ?? 0), row, value, { ...options, style: delay(clock) }));
      col += value.length + (options.skip ?? 0);
    }
    row += 1;
  };

  command('whoami');
  wrapColumns(`${config.name}, ${config.role}, ${config.location}`, COLS).forEach((line, i) => {
    const named = i === 0 && line.startsWith(config.name);
    const rest = named ? line.slice(config.name.length) : line;
    output([...(named ? [[config.name, { fill: C.text, bold: true }]] : []), ...(rest ? [[rest]] : [])]);
  });
  clock += 0.35;

  command('cat about.txt');
  for (const line of wrapColumns(config.about, COLS)) output([[line]]);
  clock += 0.35;

  command(`./activity --weeks ${weeks.length}`);
  const peak = Math.max(1, ...weeks.map((week) => week.total));
  // One bar per column with the count beside them, or, when that does not fit, bars
  // squeezed across the full width with the count on its own line underneath.
  const beside = weeks.length + 2 + 'contributions'.length <= COLS;
  const pitch = beside ? CW : (COLS * CW) / weeks.length;
  const base = top(row) + LH * 2 - 6;
  weeks.forEach((week, i) => {
    // Square-root scale, so quiet weeks still show next to the busiest one.
    const ratio = Math.sqrt(week.total / peak);
    const height = week.total ? Math.max(3, ratio * (LH * 2 - 12)) : 2;
    const fill = week.total ? C.heat[Math.min(3, Math.max(0, Math.ceil(ratio * 4) - 1))] : C.track;
    // The current week is still filling up, so draw it lighter than the finished ones.
    const unfinished = i === weeks.length - 1 && week.days < 7;
    parts.push(`<rect class="b" x="${num(PAD_X + i * pitch + 1)}" y="${num(base - height)}" width="${num(pitch - 2)}" height="${num(height)}" rx="1" fill="${fill}"${unfinished ? ' opacity=".55"' : ''} style="${delay(clock + i * 0.01)}"/>`);
  });
  const count = [[full(stats.contributions), { fill: C.amber, bold: true }], ['contributions', { fill: C.muted }]];
  clock += 0.3;
  if (beside) {
    count.forEach(([value, options], i) => parts.push(text(weeks.length + 2, row + i, value, { ...options, style: delay(clock) })));
    row += 2;
  } else {
    row += 2;
    output([count[0], [count[1][0], { ...count[1][1], skip: 1 }]]);
  }
  clock += 0.7;

  command('./stats');
  const totals = [['repos', String(stats.repos)], ['packages', String(stats.packages)], ['installs', compact(stats.installs)], ['stars', String(stats.stars)]];
  const pieces = (list) => list.flatMap(([name, value], i) => [[name, { fill: C.muted, skip: i ? 3 : 0 }], [value, { fill: C.amber, skip: 1 }]]);
  const width = totals.reduce((sum, [name, value], i) => sum + name.length + 1 + value.length + (i ? 3 : 0), 0);
  if (width <= COLS) {
    output(pieces(totals));
  } else {
    output(pieces(totals.slice(0, 2)));
    output(pieces(totals.slice(2)));
  }
  clock += 0.35;

  prompt();
  parts.push(`<rect class="f" x="${x(promptCols)}" y="${top(row) + 3}" width="${CW}" height="18" fill="${C.soft}" style="animation-delay:${num(clock)}s,${num(clock)}s"/>`);
  row += 1;

  // Without animation (reduced motion, or a viewer that does not animate) everything is
  // simply there: the keyframes only describe the hidden state things start from.
  const css = `text{font-size:15px}
.m,.k{opacity:0}
@media (prefers-reduced-motion:no-preference){
.o{animation:show .01s linear backwards}
.m{animation:slide 1s linear backwards}
.k{animation:slide 1s linear}
.b{transform-box:fill-box;transform-origin:50% 100%;animation:rise .4s cubic-bezier(.2,.9,.25,1) backwards}
.f{animation:show .01s linear backwards,blink 1.1s steps(1) infinite}
@keyframes show{from{opacity:0}}
@keyframes slide{from{opacity:1;transform:translateX(0)}to{opacity:1;transform:translateX(var(--w))}}
@keyframes rise{from{transform:scaleY(0)}}
@keyframes blink{50%{opacity:0}}
}
`;
  const label = `Terminal session. whoami: ${config.name}, ${config.role}, ${config.location}. ${full(stats.contributions)} contributions in the last ${weeks.length} weeks.`;
  return terminalWindow(W, BAR + PAD_Y * 2 + row * LH, BAR, `${config.shell}: ~`, label, parts.join('\n'), css);
}

const INK = { dim: C.muted, text: C.soft, bright: C.text, green: C.green, blue: '#a5d6ff', amber: C.amber, purple: '#d2a8ff', orange: '#ffa657' };

/**
 * Colours one line of a code tile. A plain string is treated as PHP-like code (strings,
 * method names, class names, comments); a list of [text, ink] pairs is coloured as given.
 */
function highlight(line) {
  if (Array.isArray(line)) return line.map(([value, ink]) => [value, INK[ink] ?? C.soft]);
  if (line.trim().startsWith('//')) return [[line, C.muted]];
  const pieces = [];
  const token = /('[^']*')|(->|::)(\w+)|\b([A-Z]\w+)/g;
  let last = 0;
  for (let match = token.exec(line); match; match = token.exec(line)) {
    if (match.index > last) pieces.push([line.slice(last, match.index), C.soft]);
    if (match[1]) pieces.push([match[1], '#a5d6ff']);
    else if (match[2]) pieces.push([match[2], C.soft], [match[3], '#d2a8ff']);
    else pieces.push([match[4], '#ffa657']);
    last = token.lastIndex;
  }
  if (last < line.length) pieces.push([line.slice(last), C.soft]);
  return pieces;
}

/** A small terminal window showing a real screenshot of the project, or a few lines of its code. */
function showcaseCard(project) {
  const W = 272, BAR = 26, SHOT = 160, PAD = 14, H = 286;
  const textTop = BAR + SHOT;
  const lines = wrapColumns(project.text, Math.floor((W - PAD * 2) / 6.9), 2);
  // Code lines are centred as a block in the space a screenshot would take.
  const codeTop = BAR + 1 + (SHOT - (project.code?.length ?? 0) * 19) / 2 + 14;
  const picture = project.code
    ? `<rect y="${BAR + 1}" width="${W}" height="${SHOT}" fill="#0d1117"/>
${project.code.map((line, i) => `<text x="${PAD}" y="${num(codeTop + i * 19)}" font-size="11" xml:space="preserve">${highlight(line).map(([value, fill]) => `<tspan fill="${fill}">${esc(value)}</tspan>`).join('')}</text>`).join('\n')}`
    : `<image x="0" y="${BAR + 1}" width="${W}" height="${SHOT}" preserveAspectRatio="xMidYMid slice" href="data:image/jpeg;base64,${project.shot}"/>`;

  const foot = [];
  if (project.language) {
    foot.push(`<circle cx="${PAD + 4}" cy="${H - 20}" r="4" fill="${onDark(project.language.color)}"/>`);
    foot.push(`<text x="${PAD + 14}" y="${H - 16}" font-size="11" fill="${C.muted}">${esc(project.language.name)}</text>`);
  }
  if (project.release) {
    foot.push(`<text x="${W - PAD}" y="${H - 16}" font-size="11" fill="${C.muted}" text-anchor="end">${esc(project.release)}</text>`);
  }
  const stars = project.stars > 0
    ? `<polygon points="${starPoints(W - PAD - 6 - String(project.stars).length * 6.9 - 6, textTop + 19)}" fill="${C.amber}"/>
<text x="${W - PAD}" y="${textTop + 23}" font-size="11.5" fill="${C.soft}" text-anchor="end">${full(project.stars)}</text>`
    : '';

  const body = `${picture}
<path d="M0 ${textTop + 1.5}H${W}" stroke="${C.border}"/>
<text x="${PAD}" y="${textTop + 24}" font-size="14" font-weight="700" fill="${C.text}">${esc(project.title)}</text>
${stars}
${lines.map((line, i) => `<text x="${PAD}" y="${textTop + 46 + i * 16}" font-size="11.5" fill="${C.soft}">${esc(line)}</text>`).join('\n')}
${foot.join('\n')}`;
  return terminalWindow(W, H, BAR, `~/shipped/${project.dir ?? project.repo}`, `${project.title}: ${project.text}`, body);
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

const image = (path, width, alt) => `<img src="${RAW}/${path}" width="${width}" alt="${esc(alt)}">`;

// ---------------------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------------------

async function main() {
  const [{ calendar, repos }, installs, toolbox] = await Promise.all([
    fetchGithub(),
    fetchPackagist(config.packagistVendors),
    toolboxIcons(join(ROOT, 'assets/toolbox.svg')),
  ]);

  const weeks = calendar.weeks.slice(-53).map((week) => ({
    total: week.contributionDays.reduce((sum, day) => sum + day.contributionCount, 0),
    days: week.contributionDays.length,
  }));
  const stats = {
    contributions: calendar.totalContributions,
    repos: repos.length,
    stars: repos.reduce((sum, repo) => sum + repo.stargazerCount, 0),
    packages: Object.keys(installs).length,
    installs: Object.values(installs).reduce((sum, count) => sum + count, 0),
  };

  const featured = config.featured.map((entry) => {
    const repo = repos.find((candidate) => candidate.name.toLowerCase() === entry.repo.toLowerCase());
    if (!repo) throw new Error(`Featured repo "${entry.repo}" is not one of ${config.login}'s public, non-fork repos.`);
    // A card shows either a few lines of code from the config or a screenshot from assets/shots.
    const shotPath = join(ROOT, 'assets/shots', `${entry.repo}.jpg`);
    if (!entry.code && !existsSync(shotPath)) {
      throw new Error(`Featured repo "${entry.repo}" needs a 540x320 screenshot at assets/shots/${entry.repo}.jpg, or "code" lines in the config.`);
    }
    if (entry.packagist && !(entry.packagist in installs)) {
      throw new Error(`Featured repo "${entry.repo}" names a Packagist package that was not found: ${entry.packagist}.`);
    }
    const version = repo.latestRelease?.tagName.match(/\d+(\.\d+)+.*/);
    return {
      ...entry,
      text: entry.text.replace('{installs}', entry.packagist ? compact(installs[entry.packagist]) : ''),
      url: repo.url,
      stars: repo.stargazerCount,
      language: repo.primaryLanguage,
      release: version ? `v${version[0]}` : null,
      shot: entry.code ? null : readFileSync(shotPath).toString('base64'),
    };
  });

  // The newest releases across all repos, leaving out the ones the config hides.
  const hidden = new Set((config.releases?.exclude ?? []).map((name) => name.toLowerCase()));
  const releases = repos
    .filter((repo) => repo.latestRelease?.publishedAt && !hidden.has(repo.name.toLowerCase()))
    .map((repo) => {
      const version = repo.latestRelease.tagName.match(/\d+(\.\d+)+.*/);
      return {
        title: config.featured.find((entry) => entry.repo.toLowerCase() === repo.name.toLowerCase())?.title ?? repo.name,
        version: version ? `v${version[0]}` : repo.latestRelease.tagName,
        date: repo.latestRelease.publishedAt.slice(0, 10),
        url: repo.latestRelease.url,
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title))
    .slice(0, config.releases?.count ?? 3);

  // Everything is fetched and checked by now, so a failure above leaves the old files untouched.
  const files = {
    'assets/terminal.svg': terminalCard({ weeks, stats }, { cols: 68, shell: config.shell }),
    'assets/terminal-mobile.svg': terminalCard({ weeks, stats }, { cols: 40, shell: config.shell.split('@')[0] }),
    'assets/toolbox.svg': toolbox,
  };
  for (const project of featured) files[`assets/cards/${project.repo}.svg`] = showcaseCard(project);

  const statValues = {
    contributions: full(stats.contributions),
    repos: full(stats.repos),
    stars: full(stats.stars),
    packages: full(stats.packages),
    installs: compact(stats.installs),
    ...Object.fromEntries(Object.entries(installs).map(([name, count]) => [`installs:${name}`, compact(count)])),
  };
  const heroAlt = `Terminal session. whoami: ${config.name}, ${config.role}, ${config.location}. about.txt: ${config.about} `
    + 'Then a bar for each of the last 53 weeks of contributions, and totals for repos, packages, installs and stars.';
  const toolboxWidth = Math.min(Object.keys(config.icons).length, config.iconsPerLine) * 55 + 3;

  let readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  // Phones get the narrow terminal: GitHub keeps the width media query on the <source>.
  readme = replaceRegion(readme, 'hero', `<p align="center">\n<picture><source media="(max-width: 767px)" srcset="${RAW}/assets/terminal-mobile.svg">${image('assets/terminal.svg', 830, heroAlt)}</picture>\n</p>`);
  readme = replaceRegion(readme, 'releases', releases
    .map((release) => `- \`${release.date}\` [${release.title} ${release.version}](${release.url})`)
    .join('\n'));
  readme = replaceRegion(readme, 'featured', `<p align="center">\n${featured
    .map((project) => `<a href="${project.url}">${image(`assets/cards/${project.repo}.svg`, 272, `${project.title}: ${project.text}`)}</a>`)
    .join('\n')}\n</p>`);
  readme = replaceRegion(readme, 'toolbox', `<p align="center">\n${image('assets/toolbox.svg', toolboxWidth, Object.values(config.icons).join(', '))}\n</p>`);
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
