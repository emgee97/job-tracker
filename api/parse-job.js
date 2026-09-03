// Vercel serverless function: fetches a job posting URL server-side (avoids CORS)
// and extracts structured fields, preferring schema.org JSON-LD "JobPosting" data
// embedded by most job boards/ATS. No paid API involved.

const ALLOWED_PROTOCOLS = ['http:', 'https:'];

const SOURCE_MAP = {
  'linkedin.com': 'LinkedIn',
  'indeed.com': 'Indeed',
  'indeed.fr': 'Indeed',
  'welcometothejungle.com': 'Welcome to the Jungle',
  'apec.fr': 'Apec',
  'monster.fr': 'Monster',
  'glassdoor.fr': 'Glassdoor',
  'glassdoor.com': 'Glassdoor',
  'pole-emploi.fr': 'France Travail',
  'francetravail.fr': 'France Travail',
  'hellowork.com': 'HelloWork',
  'greenhouse.io': 'Greenhouse',
  'lever.co': 'Lever',
};

module.exports = async function handler(req, res) {
  const rawUrl = req.query.url;
  if (!rawUrl || typeof rawUrl !== 'string') {
    return res.status(400).json({ error: 'Paramètre url manquant' });
  }

  let target;
  try { target = new URL(rawUrl); } catch { return res.status(400).json({ error: 'URL invalide' }); }
  if (!ALLOWED_PROTOCOLS.includes(target.protocol)) {
    return res.status(400).json({ error: 'Protocole non autorisé' });
  }
  if (isPrivateHost(target.hostname)) {
    return res.status(400).json({ error: 'Hôte non autorisé' });
  }

  let html;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch(target.toString(), {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobTrackerBot/1.0)' },
    });
    clearTimeout(timer);
    if (!resp.ok) return res.status(400).json({ error: `Le site a répondu ${resp.status}` });
    const buf = await resp.arrayBuffer();
    if (buf.byteLength > 3_000_000) return res.status(400).json({ error: 'Page trop volumineuse' });
    html = Buffer.from(buf).toString('utf-8');
  } catch (e) {
    return res.status(502).json({ error: 'Impossible de récupérer la page (' + e.message + ')' });
  }

  return res.status(200).json(extractJobData(html, target));
};

function isPrivateHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local')) return true;
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
  return false;
}

function extractJobData(html, target) {
  const ldMatches = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  let posting = null;
  for (const m of ldMatches) {
    try {
      const data = JSON.parse(m[1].trim());
      posting = findJobPosting(data);
      if (posting) break;
    } catch { /* malformed JSON-LD, skip */ }
  }

  const source = guessSource(target.hostname);

  if (posting) {
    return {
      found: true,
      poste: posting.title || '',
      entreprise: (posting.hiringOrganization && posting.hiringOrganization.name) || '',
      lieu: extractLocation(posting.jobLocation),
      salaire: extractSalary(posting.baseSalary),
      notes: stripHtml(posting.description).slice(0, 2000),
      source,
    };
  }

  const metaTitle = matchMeta(html, 'og:title') || matchTitleTag(html);
  const metaDesc = matchMeta(html, 'og:description') || matchMeta(html, 'description', 'name');
  const ogSite = matchMeta(html, 'og:site_name');

  return {
    found: false,
    poste: metaTitle,
    entreprise: '',
    lieu: '',
    salaire: null,
    notes: stripHtml(metaDesc).slice(0, 2000),
    source: ogSite || source,
  };
}

function findJobPosting(data) {
  if (!data) return null;
  const items = Array.isArray(data) ? data : [data];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const types = Array.isArray(item['@type']) ? item['@type'] : [item['@type']];
    if (types.includes('JobPosting')) return item;
    if (item['@graph']) {
      const found = findJobPosting(item['@graph']);
      if (found) return found;
    }
  }
  return null;
}

function extractSalary(baseSalary) {
  if (!baseSalary) return null;
  const val = baseSalary.value || baseSalary;
  let amount = val.value ?? val.maxValue ?? val.minValue;
  if (amount == null) return null;
  amount = Number(amount);
  if (!Number.isFinite(amount)) return null;
  const unit = String(val.unitText || baseSalary.unitText || '').toUpperCase();
  if (unit === 'MONTH') amount *= 12;
  else if (unit === 'HOUR') amount *= 1820;
  else if (unit === 'WEEK') amount *= 52;
  return Math.round(amount);
}

function extractLocation(jobLocation) {
  if (!jobLocation) return '';
  const loc = Array.isArray(jobLocation) ? jobLocation[0] : jobLocation;
  if (typeof loc === 'string') return loc;
  const addr = loc && loc.address;
  if (!addr) return '';
  const parts = [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean);
  return parts.join(', ');
}

function guessSource(hostname) {
  const h = hostname.replace(/^www\./, '');
  for (const key in SOURCE_MAP) {
    if (h.endsWith(key)) return SOURCE_MAP[key];
  }
  return h;
}

function matchMeta(html, key, attr = 'property') {
  const re1 = new RegExp(`<meta[^>]+${attr}=["']${key}["'][^>]*content=["']([^"']*)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*${attr}=["']${key}["']`, 'i');
  const m = html.match(re1) || html.match(re2);
  return m ? decodeEntities(m[1]) : '';
}

function matchTitleTag(html) {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? decodeEntities(m[1]).trim() : '';
}

function stripHtml(s) {
  if (!s) return '';
  return decodeEntities(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}
