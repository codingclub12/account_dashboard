'use strict';
/**
 * Derives the analytics dimensions from request metadata.
 *
 * Everything here turns a raw request into a small set of coarse buckets. The
 * raw user agent and the IP address are deliberately never returned, so they
 * are never stored: this site is used by school students, and a UA string plus
 * an IP is a fingerprint. Device family, browser family, OS family and country
 * answer the questions the analytics page actually asks without retaining
 * anything that identifies a person.
 */

// ── BOTS ──────────────────────────────────────────────────────────────────────
// Bot traffic wrecks acquisition and device reports more than any other single
// factor, so sessions are flagged at ingest and excluded from analytics by
// default rather than filtered downstream.
const BOT_PATTERNS = [
  'bot', 'crawler', 'spider', 'slurp', 'headless', 'lighthouse', 'pagespeed',
  'curl/', 'wget', 'python-requests', 'go-http-client', 'java/', 'okhttp',
  'facebookexternalhit', 'ahrefs', 'semrush', 'mj12', 'dotbot', 'bingpreview',
  'gptbot', 'claudebot', 'ccbot', 'perplexity', 'applebot', 'petalbot',
];

function isBot(ua) {
  const s = String(ua || '').toLowerCase();
  if (!s) return true; // a real browser always sends one
  return BOT_PATTERNS.some(p => s.includes(p));
}

// ── DEVICE / BROWSER / OS ─────────────────────────────────────────────────────
function deviceFamily(ua) {
  const s = String(ua || '').toLowerCase();
  if (/ipad|tablet|playbook|silk|(android(?!.*mobile))/.test(s)) return 'tablet';
  if (/mobi|iphone|ipod|android.*mobile|windows phone/.test(s)) return 'mobile';
  return 'desktop';
}

function browserFamily(ua) {
  const s = String(ua || '');
  // Order matters: Edge and Opera both claim to be Chrome, Chrome claims Safari.
  if (/Edg[A-Z]?\//.test(s)) return 'Edge';
  if (/OPR\/|Opera/.test(s)) return 'Opera';
  if (/SamsungBrowser/.test(s)) return 'Samsung Internet';
  if (/Firefox\//.test(s)) return 'Firefox';
  if (/Chrome\//.test(s)) return 'Chrome';
  if (/Safari\//.test(s)) return 'Safari';
  return 'Other';
}

function osFamily(ua) {
  const s = String(ua || '');
  if (/CrOS/.test(s)) return 'ChromeOS';       // before Linux — CrOS says Linux too
  if (/Windows NT/.test(s)) return 'Windows';
  if (/iPhone|iPad|iPod/.test(s)) return 'iOS';
  if (/Android/.test(s)) return 'Android';
  if (/Mac OS X/.test(s)) return 'macOS';
  if (/Linux/.test(s)) return 'Linux';
  return 'Other';
}

// ── ACQUISITION CHANNEL ───────────────────────────────────────────────────────
const SEARCH_HOSTS = ['google.', 'bing.', 'duckduckgo.', 'yahoo.', 'ecosia.', 'brave.', 'search.', 'baidu.', 'yandex.'];
const SOCIAL_HOSTS = ['facebook.', 'fb.', 'twitter.', 'x.com', 't.co', 'reddit.', 'linkedin.', 'lnkd.in',
  'instagram.', 'tiktok.', 'youtube.', 'youtu.be', 'pinterest.', 'quora.', 'discord.', 'bsky.'];
const EMAIL_HOSTS = ['mail.google.', 'outlook.', 'mail.yahoo.', 'mail.proton'];
// Worth its own bucket: a referral from an LMS means a teacher assigned the page
// to a class, which is a completely different signal from an organic visit.
const CLASSROOM_HOSTS = ['classroom.google.', 'teams.microsoft.', 'office.com', 'sharepoint.',
  'instructure.com', 'canvas.', 'schoology.', 'clever.com', 'classlink.', 'blackboard.',
  'moodle.', 'edmodo.', 'nearpod.', 'peardeck.'];

function hostOf(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  try {
    return new URL(s).hostname.toLowerCase().replace(/^www\./, '');
  } catch (e) {
    return '';
  }
}

function matches(host, list) {
  return list.some(p => host === p.replace(/\.$/, '') || host.includes(p));
}

/**
 * Channel precedence: explicit UTM tagging beats an inferred referrer, because
 * a tagged campaign link is a statement of intent and a referrer is a guess.
 */
function classifyChannel({ referrer, utm_medium, utm_source, ownHosts }) {
  const medium = String(utm_medium || '').toLowerCase();
  const source = String(utm_source || '').toLowerCase();

  if (/cpc|ppc|paid|display|banner/.test(medium)) return 'paid';
  if (/email|newsletter/.test(medium) || /email|newsletter/.test(source)) return 'email';
  if (/social/.test(medium)) return 'social';
  if (/classroom|lms/.test(medium)) return 'classroom';
  if (medium === 'organic') return 'organic';

  const host = hostOf(referrer);
  if (!host) return 'direct';
  if ((ownHosts || []).some(own => host === own || host.endsWith('.' + own))) return 'internal';
  if (matches(host, CLASSROOM_HOSTS)) return 'classroom';
  if (matches(host, SEARCH_HOSTS)) return 'organic';
  if (matches(host, SOCIAL_HOSTS)) return 'social';
  if (matches(host, EMAIL_HOSTS)) return 'email';
  return 'referral';
}

// ── COUNTRY ───────────────────────────────────────────────────────────────────
// Set by the edge, not by the client. Absent behind a plain Railway domain, in
// which case country is simply null rather than guessed.
function countryOf(headers) {
  const raw = headers['cf-ipcountry'] || headers['x-vercel-ip-country'] ||
              headers['x-geo-country'] || headers['fastly-client-country'] || '';
  const code = String(raw).toUpperCase();
  return /^[A-Z]{2}$/.test(code) && code !== 'XX' ? code : null;
}

/** Everything the ingest endpoint needs, derived in one pass. */
function enrichRequest(req, ownHosts) {
  const ua = req.headers['user-agent'] || '';
  return {
    bot: isBot(ua) ? 1 : 0,
    device: deviceFamily(ua),
    browser: browserFamily(ua),
    os: osFamily(ua),
    country: countryOf(req.headers),
    ownHosts: ownHosts || [],
  };
}

module.exports = {
  isBot, deviceFamily, browserFamily, osFamily,
  hostOf, classifyChannel, countryOf, enrichRequest,
};
