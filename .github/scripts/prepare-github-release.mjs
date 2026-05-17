#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const version = pkg.version;
if (!version || version.includes('-')) {
  throw new Error(`Refusing to create latest GitHub release for non-stable version: ${version}`);
}
const tag = `v${version}`;
const sha = process.env.GITHUB_SHA || git(['rev-parse', 'HEAD']);
const repo = process.env.GITHUB_REPOSITORY || git(['config', '--get', 'remote.origin.url']).replace(/^.*github.com[:/]/, '').replace(/\.git$/, '');

function git(args, options = {}) {
  return execFileSync('git', args, { encoding: 'utf8', ...options }).trim();
}

function changelogSection(markdown, wantedVersion) {
  const lines = markdown.split(/\r?\n/);
  const header = new RegExp(`^##\\s+\\[?v?${wantedVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]?\\s*$`);
  const start = lines.findIndex((line) => header.test(line.trim()));
  if (start === -1) return '';
  const end = lines.findIndex((line, index) => index > start && /^##\s+/.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim();
}

function previousTag(currentTag) {
  const tags = git(['tag', '--merged', sha, '--sort=-creatordate']).split('\n').filter(Boolean);
  return tags.find((candidate) => candidate !== currentTag && /^v\d+\.\d+\.\d+(?:$|-)/.test(candidate)) || '';
}

const changelog = existsSync('CHANGELOG.md') ? readFileSync('CHANGELOG.md', 'utf8') : '';
const section = changelog ? changelogSection(changelog, version) : '';
const prev = previousTag(tag);
const range = prev ? `${prev}..${sha}` : sha;
const commits = git(['log', '--pretty=format:- %s (%h)', range]).split('\n').filter(Boolean).join('\n');
const compare = prev ? `https://github.com/${repo}/compare/${prev}...${tag}` : '';

let notes = `# ${tag}\n\n`;
if (section) {
  notes += `${section}\n\n`;
} else {
  notes += '_No matching CHANGELOG.md section was found for this version._\n\n';
}
if (compare) notes += `**Full diff:** ${compare}\n\n`;
if (commits) notes += `## Commits\n\n${commits}\n`;

writeFileSync('release-notes.md', notes);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
}
console.log(`Prepared ${tag} release notes${prev ? ` from ${prev}` : ''}.`);
