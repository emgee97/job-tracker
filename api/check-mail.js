// Fonction Vercel (déclenchée par Vercel Cron ou manuellement depuis les Réglages)
// qui relève la boîte Gmail par IMAP (mot de passe d'application, gratuit) et
// reclasse automatiquement les candidatures actives sur la base de mots-clés
// détectés dans les mails (refus, entretien, offre). Aucune API IA payante.

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { createClient } = require('@supabase/supabase-js');

const CLOSED = ['Refusée', 'Abandonnée'];

// Ordre de priorité : une offre/un entretien prime sur un refus si jamais
// plusieurs signaux apparaissent dans le même mail (rare en pratique).
const RULES = [
  {
    statut: 'Offre reçue',
    patterns: [
      /avons le plaisir de vous (proposer|offrir)/i,
      /proposition d.?embauche/i,
      /promesse d.?embauche/i,
      /vous adresser (notre|une) offre/i,
      /contrat de travail ci-joint/i,
    ],
  },
  {
    statut: 'Entretien planifié',
    patterns: [
      /vous rencontrer/i,
      /planifier un entretien/i,
      /convier.*entretien/i,
      /disponibilit(é|es).*entretien/i,
      /entretien (téléphonique|visio|physique)/i,
      /échanger avec vous/i,
      /prochaine étape.*recrutement/i,
    ],
  },
  {
    statut: 'Refusée',
    patterns: [
      /ne (pouvons|pourrons) pas donner suite/i,
      /ne donnerons pas suite/i,
      /n.?a pas été retenue?/i,
      /ne sera pas retenue?/i,
      /avons décidé de ne pas poursuivre/i,
      /au regret de vous (informer|annoncer)/i,
      /un autre (profil|candidat) a été retenu/i,
      /candidature n.?a pas été sélectionnée/i,
      /process.*ne (se poursuivra|continuera) pas/i,
    ],
  },
];

module.exports = async function handler(req, res) {
  const authError = checkAuth(req);
  if (authError) return res.status(401).json({ error: authError });

  const requiredEnv = ['GMAIL_USER', 'GMAIL_APP_PASSWORD', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
  const missing = requiredEnv.filter(k => !process.env[k]);
  if (missing.length) {
    return res.status(500).json({ error: 'Variables d\'environnement manquantes: ' + missing.join(', ') });
  }

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  let client;
  try {
    const state = await getState(db);

    client = new ImapFlow({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
      logger: false,
    });
    await client.connect();

    const lock = await client.getMailboxLock('INBOX');
    let checked = 0;
    const updates = [];
    try {
      const uidNext = client.mailbox.uidNext;
      const firstRun = state.last_uid == null;
      const startUid = firstRun ? uidNext : state.last_uid + 1;

      if (startUid <= uidNext - 1) {
        const { data: candidatures, error } = await db
          .from('candidatures')
          .select('id, entreprise, statut, feedback')
          .not('statut', 'in', `(${CLOSED.map(s => `"${s}"`).join(',')})`);
        if (error) throw error;

        for await (const msg of client.fetch(`${startUid}:${uidNext - 1}`, { envelope: true, source: true }, { uid: true })) {
          checked++;
          const parsed = await simpleParser(msg.source);
          const fromAddr = (parsed.from && parsed.from.value && parsed.from.value[0]) || {};
          const fromEmail = fromAddr.address || '';
          const fromName = fromAddr.name || '';
          const domain = fromEmail.split('@')[1] || '';
          const bodyText = (parsed.text || '').slice(0, 5000);
          const subject = parsed.subject || '';

          const match = findMatchingCandidature(candidatures, fromName, domain);
          if (!match) continue;

          const newStatut = classify(subject + '\n' + bodyText);
          if (!newStatut) continue;

          const today = new Date().toISOString().split('T')[0];
          const note = `[Auto-détecté ${today}] "${subject}" → ${newStatut}`;
          const feedback = match.feedback ? `${match.feedback}\n${note}` : note;

          const patch = { statut: newStatut, feedback, updated_at: new Date().toISOString() };
          if (newStatut === 'Refusée' || newStatut === 'Offre reçue') patch.date_reponse = today;

          const { error: updErr } = await db.from('candidatures').update(patch).eq('id', match.id);
          if (!updErr) {
            updates.push({ entreprise: match.entreprise, statut: newStatut, subject });
            match.statut = newStatut; // évite un second match sur le même run
          }
        }
      }

      await setState(db, uidNext - 1);
    } finally {
      lock.release();
    }

    return res.status(200).json({ ok: true, checked, updates });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  } finally {
    if (client) { try { await client.logout(); } catch { /* déjà fermé */ } }
  }
};

function checkAuth(req) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers['authorization'] || '';
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) return null;

  const appPassword = process.env.VITE_APP_PASSWORD;
  const providedPassword = req.headers['x-app-password'];
  if (appPassword && providedPassword && providedPassword === appPassword) return null;

  return 'Non autorisé';
}

async function getState(db) {
  const { data, error } = await db.from('mail_sync_state').select('*').eq('id', 1).maybeSingle();
  if (error) throw error;
  return data || { last_uid: null };
}

async function setState(db, lastUid) {
  await db.from('mail_sync_state').upsert({ id: 1, last_uid: lastUid, last_checked_at: new Date().toISOString() });
}

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function findMatchingCandidature(candidatures, fromName, domain) {
  const domainRoot = normalize((domain.split('.')[0] || ''));
  const nameNorm = normalize(fromName);
  for (const c of candidatures) {
    const entrepriseNorm = normalize(c.entreprise);
    if (entrepriseNorm.length < 3) continue;
    const domainMatch = domainRoot.length >= 3 && (domainRoot.includes(entrepriseNorm) || entrepriseNorm.includes(domainRoot));
    const nameMatch = nameNorm.length >= 3 && (nameNorm.includes(entrepriseNorm) || entrepriseNorm.includes(nameNorm));
    if (domainMatch || nameMatch) return c;
  }
  return null;
}

function classify(text) {
  for (const rule of RULES) {
    if (rule.patterns.some(re => re.test(text))) return rule.statut;
  }
  return null;
}
