// Vectorhome Reader — frontend SPA
// A 401 from any API call means the session expired/was cleared — go to login.
function redir401(r) { if (r.status === 401) { location.href = '/login'; throw new Error('unauthorized'); } }
const api = {
  async get(url) {
    const r = await fetch(url);
    redir401(r);
    if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || r.status); }
    return r.json();
  },
  async post(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    redir401(r);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || r.status), { status: r.status, data });
    return data;
  },
  async patch(url, body) {
    const r = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    redir401(r);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || r.status), { status: r.status, data });
    return data;
  },
  async put(url, body) {
    const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    redir401(r);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || r.status);
    return data;
  },
  async del(url) {
    const r = await fetch(url, { method: 'DELETE' });
    redir401(r);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || r.status);
    return data;
  },
};

// Parse a JSON blob from localStorage without letting a corrupted value crash
// the whole app at load time.
function lsJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; }
  catch { return fallback; }
}

const state = {
  selection: { type: 'all' },   // {type:'all'|'starred'|'feed'|'category', id?}
  filter: 'unread',
  items: [],
  current: null,                // current open item
  mobileEnd: false,             // showing the terminal "All read" card (mobile)
  mobileStart: false,           // showing the terminal "At start" card (mobile)
  feeds: [],
  categories: [],
  settings: { inactive_months: 9, autorefresh_seconds: 60, retention_days: 30 },
  collapsed: lsJSON('collapsed', {}),
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    // `dataset` is read-only and must be filled key-by-key; other read-only
    // props (e.g. <input list>) fall back to setAttribute.
    if (k === 'dataset') { Object.assign(n.dataset, v); continue; }
    try { n[k] = v; } catch { n.setAttribute(k, v); }
  }
  for (const k of kids) n.append(k);
  return n;
};

// ---------- Internationalization (English / French Canada) ----------
// The shipped baseline is English (Canada): no US-only spellings; dates use en-CA.
const LANGS = [
  { code: 'en', label: 'English (Canada)', locale: 'en-CA' },
  { code: 'fr', label: 'Français (Canada)', locale: 'fr-CA' },
];
const I18N = {
  en: {
    'brand': 'Reader',
    'btn.settings': 'Settings & subscriptions',
    'btn.theme': 'Theme',
    'btn.health': 'Feed problems',
    'btn.refresh': 'Refresh all feeds',
    'add.ph': 'Paste a URL or feed…',
    'add.btn': 'Add',
    'nav.readLater': 'Read Later',
    'nav.all': 'All',
    'nav.uncategorized': 'Uncategorized',
    'btn.collapseAll': 'Collapse all categories',
    'btn.expandAll': 'Expand all categories',
    'opml.import': 'Import OPML',
    'opml.export': 'Export OPML',
    'btn.hideSidebar': 'Hide sidebar',
    'btn.showSidebar': 'Show sidebar',
    'filter.unread': 'Unread',
    'filter.all': 'All',
    'btn.reload': 'Reload view (no fetch)',
    'btn.markReadMenu': '✓ Mark read ▾',
    'btn.markReadTitle': 'Mark as read',
    'mark.all': 'All articles',
    'mark.day': 'Older than one day',
    'mark.week': 'Older than one week',
    'btn.cats': 'Categories',
    'btn.catsAria': 'Open categories',
    'btn.top': 'Scroll to top',
    'btn.back': '‹ Back',
    'btn.backAria': 'Back to list',
    'unreadSuffix': ' · unread',
    'card.allRead': 'All read',
    'card.allReadSub': 'You’ve reached the end. Swipe right to go back.',
    'card.atStart': 'At start',
    'card.atStartSub': 'You’re at the beginning. Swipe left to go back.',
    'item.openOriginal': '↗ Open original',
    'item.saved': '🔖 Saved',
    'item.readLater': '🔖 Read later',
    'item.markUnread': '◌ Mark unread',
    'item.markRead': '✓ Mark read',
    'item.noContent': 'No content. Open the original.',
    'embed.openTab': '↗ Embedded content — open in a new tab',
    'embed.removed': '[embedded content removed]',
    'edge.atStart': 'At start',
    'edge.atEnd': 'At end',
    'add.title': 'Add subscription',
    'add.scrapeTitle': '🕷 Scrape this page',
    'add.scrapeDesc': (title) => 'No RSS feed found — build a feed from page links: ' + title,
    'add.category': 'Category (optional)',
    'add.catNew': '➕ New category…',
    'btn.cancel': 'Cancel',
    'btn.subscribe': 'Subscribe',
    'toast.couldNotReach': (msg) => 'Could not reach that URL: ' + msg,
    'toast.subscribed': 'Subscribed ✓',
    'confirm.scrapeInstead': 'No RSS feed found. Build a feed by scraping the page instead?',
    'toast.subscribedScraped': 'Subscribed (scraped) ✓',
    'toast.failed': (msg) => 'Failed: ' + msg,
    'toast.refreshed': (n) => `Refreshed: ${n} new`,
    'toast.refreshFailed': 'Refresh failed',
    'toast.marked': (n) => `Marked ${n} read`,
    'toast.markFailed': (msg) => 'Failed to mark read: ' + msg,
    'toast.imported': (n) => `Imported ${n} feeds`,
    'toast.opmlFailed': (msg) => 'OPML import failed: ' + msg,
    'edit.title': 'Edit subscription',
    'edit.name': 'Name',
    'edit.sourceUrl': 'Source page URL',
    'edit.feedUrl': 'Feed URL',
    'edit.rescrapeNote': 'Changing the source re-scrapes from the new page. Saved articles are kept.',
    'edit.refetchNote': 'Changing the URL re-fetches from the new feed. Saved articles are kept.',
    'edit.howToRead': 'How to read this page',
    'edit.modeAuto': 'Auto-detect',
    'edit.modePage': 'Single article (page content)',
    'edit.modeLinks': 'List of article links',
    'edit.modeHint': 'Use “Single article” for newsletter/content pages; “List of article links” for index pages.',
    'edit.solver': 'Fetch via Cloudflare challenge solver',
    'edit.solverOn': 'Loads this feed through your FlareSolverr browser solver — for feeds behind a Cloudflare “Just a moment” challenge.',
    'edit.solverOff': '⚠ No solver is configured on the server (set SOLVER_URL). Enabling this will error until one is set up.',
    'btn.saving': 'Saving…',
    'toast.savedUrlFailed': (msg) => 'Saved — but the new URL failed: ' + msg,
    'toast.saved': 'Saved ✓',
    'remove.confirmTitle': (n) => `Remove ${n} unreachable feed${n === 1 ? '' : 's'}?`,
    'remove.warn': 'These feeds failed on their last fetch. They will be permanently unsubscribed, along with their stored articles. This cannot be undone.',
    'remove.btn': (n) => `Remove ${n}`,
    'remove.removing': 'Removing…',
    'toast.removed': (n) => `Removed ${n} feed${n === 1 ? '' : 's'}`,
    'settings.close': 'Close',
    'settings.title': '⚙ Settings — Subscriptions',
    'settings.general': 'General',
    'settings.language': 'Language',
    'settings.inactiveAfter': 'Mark feeds inactive after',
    'settings.monthsNoArticle': 'months without a new article.',
    'settings.autorefreshEvery': 'Auto-refresh the view every',
    'settings.seconds': 'seconds.',
    'settings.autodelete': 'Auto-delete read items older than',
    'settings.days': 'days.',
    'settings.retentionNote': 'Read Later items are never auto-deleted. Cleanup runs daily.',
    'btn.save': 'Save',
    'toast.settingsSaved': 'Settings saved',
    'settings.addFeed': 'Add feed or newsletter',
    'settings.addPh': 'Paste a site URL, RSS feed, or newsletter link…',
    'settings.categories': 'Categories',
    'settings.newCatPh': 'New category name…',
    'btn.create': 'Create',
    'settings.noCats': 'No categories yet.',
    'settings.removeCat': 'Remove category',
    'confirm.removeCat': (name, n) => `Remove category "${name}"? Its ${n} feed(s) will move to Uncategorized.`,
    'cat.feeds': (n) => `${n} ${n === 1 ? 'feed' : 'feeds'}`,
    'settings.feeds': 'Feeds & newsletters',
    'settings.searchPh': 'Search feeds…',
    'settings.noMatch': 'No feeds match your search.',
    'settings.noneWithStatus': 'No feeds with this status.',
    'settings.noSubs': 'No subscriptions yet.',
    'settings.category': 'Category',
    'btn.edit': 'Edit',
    'btn.unsubscribe': 'Unsubscribe',
    'confirm.unsub': (title) => `Unsubscribe from "${title}"?`,
    'feed.items': (total, unread, newest) => `${total} items · ${unread} unread · ${newest ? 'newest ' + newest : 'no items yet'}`,
    'kind.newsletter': 'Newsletter',
    'kind.rss': 'RSS',
    'kind.openSource': (u) => `Open source page: ${u}`,
    'kind.openRss': (u) => `Open RSS feed: ${u}`,
    'status.active': 'Active',
    'status.inactive': 'Inactive',
    'status.unreachable': 'Unreachable',
    'status.inactiveNoItems': 'Inactive (no items)',
    'status.inactiveSince': (since, m) => `Inactive since ${since} (${m} month${m === 1 ? '' : 's'})`,
    'health.title': (parts) => `Feed problems: ${parts} — click to review`,
    'health.unreachable': (n) => `${n} unreachable`,
    'health.inactive': (n) => `${n} inactive`,
    'removeUnreachable.btn': (n) => `Remove ${n} unreachable`,
    'theme.auto': 'auto',
    'theme.light': 'light',
    'theme.dark': 'dark',
    'theme.toast': (name) => `Theme: ${name}`,
    'theme.btnTitle': (name) => `Theme: ${name} — click to change`,
    'date.justNow': 'just now',
    'date.mAgo': (n) => `${n}m ago`,
    'date.hAgo': (n) => `${n}h ago`,
    'date.dAgo': (n) => `${n}d ago`,
    'security.title': 'Security',
    'security.user': 'Signed in as',
    'security.logout': 'Log out',
    'security.2fa': 'Two-factor authentication (TOTP)',
    'security.2faOn': 'Enabled',
    'security.2faOff': 'Disabled',
    'security.enable': 'Enable two-factor',
    'security.disable': 'Disable',
    'security.regen': 'Regenerate recovery codes',
    'security.recoveryLeft': (n) => `${n} recovery code${n === 1 ? '' : 's'} left`,
    'security.setupTitle': 'Set up two-factor',
    'security.setupIntro': 'Add this to your authenticator app (e.g. Bitwarden): paste the secret key (or open the otpauth link), then enter the 6-digit code to confirm.',
    'security.secretKey': 'Secret key',
    'security.enterCode': 'Enter the 6-digit code',
    'security.confirm': 'Confirm',
    'security.recoveryTitle': 'Recovery codes',
    'security.recoveryIntro': 'Save these now — each works once if you lose your authenticator. They won’t be shown again.',
    'security.download': 'Download',
    'security.copy': 'Copy',
    'security.copied': 'Copied',
    'security.done': 'Done',
    'security.changePw': 'Change password',
    'security.current': 'Current password',
    'security.new': 'New password (min 8 chars)',
    'security.confirmNew': 'Confirm new password',
    'security.pwChanged': 'Password changed ✓',
    'security.confirmDisable': 'Disable two-factor? Enter your password to confirm.',
    'security.confirmRegen': 'Regenerate recovery codes? Your current codes will stop working. Enter your password.',
    'security.password': 'Password',
    'security.err.bad_code': 'Invalid authentication code.',
    'security.err.bad_password': 'Wrong password.',
    'security.err.bad_current': 'Current password is incorrect.',
    'security.err.too_short': 'Password must be at least 8 characters.',
    'security.err.mismatch': 'The new passwords don’t match.',
    'search.ph': 'Search articles…',
    'search.title': (q) => `Search: “${q}”`,
    'search.none': 'No results.',
  },
  fr: {
    'brand': 'Lecteur',
    'btn.settings': 'Paramètres et abonnements',
    'btn.theme': 'Thème',
    'btn.health': 'Problèmes de fil',
    'btn.refresh': 'Actualiser tous les fils',
    'add.ph': 'Coller une URL ou un fil…',
    'add.btn': 'Ajouter',
    'nav.readLater': 'À lire plus tard',
    'nav.all': 'Tout',
    'nav.uncategorized': 'Sans catégorie',
    'btn.collapseAll': 'Réduire toutes les catégories',
    'btn.expandAll': 'Développer toutes les catégories',
    'opml.import': 'Importer OPML',
    'opml.export': 'Exporter OPML',
    'btn.hideSidebar': 'Masquer la barre latérale',
    'btn.showSidebar': 'Afficher la barre latérale',
    'filter.unread': 'Non lus',
    'filter.all': 'Tous',
    'btn.reload': 'Recharger la vue (sans téléchargement)',
    'btn.markReadMenu': '✓ Marquer lu ▾',
    'btn.markReadTitle': 'Marquer comme lu',
    'mark.all': 'Tous les articles',
    'mark.day': 'Plus vieux qu’un jour',
    'mark.week': 'Plus vieux qu’une semaine',
    'btn.cats': 'Catégories',
    'btn.catsAria': 'Ouvrir les catégories',
    'btn.top': 'Remonter en haut',
    'btn.back': '‹ Retour',
    'btn.backAria': 'Retour à la liste',
    'unreadSuffix': ' · non lus',
    'card.allRead': 'Tout est lu',
    'card.allReadSub': 'Vous avez atteint la fin. Glissez vers la droite pour revenir.',
    'card.atStart': 'Au début',
    'card.atStartSub': 'Vous êtes au tout début. Glissez vers la gauche pour revenir.',
    'item.openOriginal': '↗ Ouvrir l’original',
    'item.saved': '🔖 Enregistré',
    'item.readLater': '🔖 À lire plus tard',
    'item.markUnread': '◌ Marquer non lu',
    'item.markRead': '✓ Marquer lu',
    'item.noContent': 'Aucun contenu. Ouvrez l’original.',
    'embed.openTab': '↗ Contenu intégré — ouvrir dans un nouvel onglet',
    'embed.removed': '[contenu intégré retiré]',
    'edge.atStart': 'Au début',
    'edge.atEnd': 'À la fin',
    'add.title': 'Ajouter un abonnement',
    'add.scrapeTitle': '🕷 Extraire cette page',
    'add.scrapeDesc': (title) => 'Aucun fil RSS trouvé — créer un fil à partir des liens de la page : ' + title,
    'add.category': 'Catégorie (facultatif)',
    'add.catNew': '➕ Nouvelle catégorie…',
    'btn.cancel': 'Annuler',
    'btn.subscribe': 'S’abonner',
    'toast.couldNotReach': (msg) => 'Impossible d’atteindre cette URL : ' + msg,
    'toast.subscribed': 'Abonné ✓',
    'confirm.scrapeInstead': 'Aucun fil RSS trouvé. Créer un fil en extrayant la page à la place?',
    'toast.subscribedScraped': 'Abonné (extrait) ✓',
    'toast.failed': (msg) => 'Échec : ' + msg,
    'toast.refreshed': (n) => `Actualisé : ${n} nouveau${n === 1 ? '' : 'x'}`,
    'toast.refreshFailed': 'Échec de l’actualisation',
    'toast.marked': (n) => `${n} marqué${n === 1 ? '' : 's'} lu${n === 1 ? '' : 's'}`,
    'toast.markFailed': (msg) => 'Échec du marquage comme lu : ' + msg,
    'toast.imported': (n) => `${n} fils importés`,
    'toast.opmlFailed': (msg) => 'Échec de l’importation OPML : ' + msg,
    'edit.title': 'Modifier l’abonnement',
    'edit.name': 'Nom',
    'edit.sourceUrl': 'URL de la page source',
    'edit.feedUrl': 'URL du fil',
    'edit.rescrapeNote': 'Changer la source réextrait à partir de la nouvelle page. Les articles enregistrés sont conservés.',
    'edit.refetchNote': 'Changer l’URL récupère à partir du nouveau fil. Les articles enregistrés sont conservés.',
    'edit.howToRead': 'Comment lire cette page',
    'edit.modeAuto': 'Détection automatique',
    'edit.modePage': 'Article unique (contenu de la page)',
    'edit.modeLinks': 'Liste de liens d’articles',
    'edit.modeHint': 'Utilisez « Article unique » pour les infolettres et pages de contenu; « Liste de liens d’articles » pour les pages d’index.',
    'edit.solver': 'Récupérer via le solveur de défi Cloudflare',
    'edit.solverOn': 'Charge ce fil via votre solveur de navigateur FlareSolverr — pour les fils derrière un défi Cloudflare « Just a moment ».',
    'edit.solverOff': '⚠ Aucun solveur n’est configuré sur le serveur (définir SOLVER_URL). L’activer causera une erreur tant qu’il n’est pas en place.',
    'btn.saving': 'Enregistrement…',
    'toast.savedUrlFailed': (msg) => 'Enregistré — mais la nouvelle URL a échoué : ' + msg,
    'toast.saved': 'Enregistré ✓',
    'remove.confirmTitle': (n) => `Retirer ${n} fil${n === 1 ? '' : 's'} injoignable${n === 1 ? '' : 's'}?`,
    'remove.warn': 'Ces fils ont échoué à leur dernière récupération. Ils seront désabonnés de façon permanente, avec leurs articles stockés. Cette action est irréversible.',
    'remove.btn': (n) => `Retirer ${n}`,
    'remove.removing': 'Retrait…',
    'toast.removed': (n) => `${n} fil${n === 1 ? '' : 's'} retiré${n === 1 ? '' : 's'}`,
    'settings.close': 'Fermer',
    'settings.title': '⚙ Paramètres — Abonnements',
    'settings.general': 'Général',
    'settings.language': 'Langue',
    'settings.inactiveAfter': 'Marquer les fils inactifs après',
    'settings.monthsNoArticle': 'mois sans nouvel article.',
    'settings.autorefreshEvery': 'Actualiser automatiquement la vue toutes les',
    'settings.seconds': 'secondes.',
    'settings.autodelete': 'Supprimer automatiquement les articles lus plus vieux que',
    'settings.days': 'jours.',
    'settings.retentionNote': 'Les articles « À lire plus tard » ne sont jamais supprimés. Le nettoyage s’exécute quotidiennement.',
    'btn.save': 'Enregistrer',
    'toast.settingsSaved': 'Paramètres enregistrés',
    'settings.addFeed': 'Ajouter un fil ou une infolettre',
    'settings.addPh': 'Coller l’URL d’un site, un fil RSS ou un lien d’infolettre…',
    'settings.categories': 'Catégories',
    'settings.newCatPh': 'Nom de la nouvelle catégorie…',
    'btn.create': 'Créer',
    'settings.noCats': 'Aucune catégorie pour l’instant.',
    'settings.removeCat': 'Supprimer la catégorie',
    'confirm.removeCat': (name, n) => `Supprimer la catégorie « ${name} »? Ses ${n} fil(s) iront dans « Sans catégorie ».`,
    'cat.feeds': (n) => `${n} flux`,
    'settings.feeds': 'Fils et infolettres',
    'settings.searchPh': 'Rechercher des fils…',
    'settings.noMatch': 'Aucun fil ne correspond à votre recherche.',
    'settings.noneWithStatus': 'Aucun fil avec ce statut.',
    'settings.noSubs': 'Aucun abonnement pour l’instant.',
    'settings.category': 'Catégorie',
    'btn.edit': 'Modifier',
    'btn.unsubscribe': 'Se désabonner',
    'confirm.unsub': (title) => `Se désabonner de « ${title} »?`,
    'feed.items': (total, unread, newest) => `${total} articles · ${unread} non lus · ${newest ? 'plus récent ' + newest : 'aucun article'}`,
    'kind.newsletter': 'Infolettre',
    'kind.rss': 'RSS',
    'kind.openSource': (u) => `Ouvrir la page source : ${u}`,
    'kind.openRss': (u) => `Ouvrir le fil RSS : ${u}`,
    'status.active': 'Actif',
    'status.inactive': 'Inactif',
    'status.unreachable': 'Injoignable',
    'status.inactiveNoItems': 'Inactif (aucun article)',
    'status.inactiveSince': (since, m) => `Inactif depuis ${since} (${m} mois)`,
    'health.title': (parts) => `Problèmes de fil : ${parts} — cliquez pour examiner`,
    'health.unreachable': (n) => `${n} injoignable${n === 1 ? '' : 's'}`,
    'health.inactive': (n) => `${n} inactif${n === 1 ? '' : 's'}`,
    'removeUnreachable.btn': (n) => `Retirer ${n} injoignable${n === 1 ? '' : 's'}`,
    'theme.auto': 'auto',
    'theme.light': 'clair',
    'theme.dark': 'sombre',
    'theme.toast': (name) => `Thème : ${name}`,
    'theme.btnTitle': (name) => `Thème : ${name} — cliquez pour changer`,
    'date.justNow': 'à l’instant',
    'date.mAgo': (n) => `il y a ${n} min`,
    'date.hAgo': (n) => `il y a ${n} h`,
    'date.dAgo': (n) => `il y a ${n} j`,
    'security.title': 'Sécurité',
    'security.user': 'Connecté en tant que',
    'security.logout': 'Se déconnecter',
    'security.2fa': 'Authentification à deux facteurs (TOTP)',
    'security.2faOn': 'Activée',
    'security.2faOff': 'Désactivée',
    'security.enable': 'Activer la double authentification',
    'security.disable': 'Désactiver',
    'security.regen': 'Régénérer les codes de récupération',
    'security.recoveryLeft': (n) => `${n} code${n === 1 ? '' : 's'} de récupération restant${n === 1 ? '' : 's'}`,
    'security.setupTitle': 'Configurer la double authentification',
    'security.setupIntro': 'Ajoutez ceci à votre application d’authentification (p. ex. Bitwarden) : collez la clé secrète (ou ouvrez le lien otpauth), puis entrez le code à 6 chiffres pour confirmer.',
    'security.secretKey': 'Clé secrète',
    'security.enterCode': 'Entrez le code à 6 chiffres',
    'security.confirm': 'Confirmer',
    'security.recoveryTitle': 'Codes de récupération',
    'security.recoveryIntro': 'Enregistrez-les maintenant — chacun fonctionne une seule fois si vous perdez votre authentificateur. Ils ne seront plus affichés.',
    'security.download': 'Télécharger',
    'security.copy': 'Copier',
    'security.copied': 'Copié',
    'security.done': 'Terminé',
    'security.changePw': 'Changer le mot de passe',
    'security.current': 'Mot de passe actuel',
    'security.new': 'Nouveau mot de passe (min. 8 caractères)',
    'security.confirmNew': 'Confirmer le nouveau mot de passe',
    'security.pwChanged': 'Mot de passe changé ✓',
    'security.confirmDisable': 'Désactiver la double authentification? Entrez votre mot de passe pour confirmer.',
    'security.confirmRegen': 'Régénérer les codes de récupération? Vos codes actuels cesseront de fonctionner. Entrez votre mot de passe.',
    'security.password': 'Mot de passe',
    'security.err.bad_code': 'Code d’authentification invalide.',
    'security.err.bad_password': 'Mot de passe erroné.',
    'security.err.bad_current': 'Le mot de passe actuel est incorrect.',
    'security.err.too_short': 'Le mot de passe doit comporter au moins 8 caractères.',
    'security.err.mismatch': 'Les nouveaux mots de passe ne correspondent pas.',
    'search.ph': 'Rechercher des articles…',
    'search.title': (q) => `Recherche : « ${q} »`,
    'search.none': 'Aucun résultat.',
  },
};
let lang = localStorage.getItem('lang');
if (lang !== 'en' && lang !== 'fr') lang = 'en';
function t(key, ...args) {
  const v = (I18N[lang] && I18N[lang][key] != null) ? I18N[lang][key] : I18N.en[key];
  if (v == null) return key;
  return typeof v === 'function' ? v(...args) : v;
}
function curLocale() { return (LANGS.find((l) => l.code === lang) || LANGS[0]).locale; }
function setLanguage(code) {
  if (code === lang) return;
  localStorage.setItem('lang', code);
  location.reload(); // simplest correct path: re-render every string from scratch
}
// Apply translations to static markup (data-i18n / -ph / -title / -aria).
function applyStaticI18n(root = document) {
  document.documentElement.lang = curLocale();
  root.querySelectorAll('[data-i18n]').forEach((n) => { n.textContent = t(n.dataset.i18n); });
  root.querySelectorAll('[data-i18n-ph]').forEach((n) => { n.placeholder = t(n.dataset.i18nPh); });
  root.querySelectorAll('[data-i18n-title]').forEach((n) => { n.title = t(n.dataset.i18nTitle); });
  root.querySelectorAll('[data-i18n-aria]').forEach((n) => { n.setAttribute('aria-label', t(n.dataset.i18nAria)); });
}

// Mobile layout switch (guarded so non-browser test envs default to desktop).
const mq = window.matchMedia ? window.matchMedia('(max-width: 900px)') : { matches: false, addEventListener() {} };
const isMobile = () => mq.matches;

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2500);
}

// Some feeds leave HTML entities in their titles (e.g. The Verge double-encodes
// &#8216; / &#8217;). Decode them for display. Result is used as textContent
// only, so this stays safe (no markup is interpreted).
const decodeEntities = (() => {
  const ta = document.createElement('textarea');
  return (s) => { if (s == null) return s; ta.innerHTML = String(s); return ta.value; };
})();

// Brief hint at the top/bottom edge of the stream when navigation can't go further.
let edgeHintTimer;
function edgeHint(text, where) {
  const e = $('#edge-hint');
  if (!e) return;
  e.textContent = text;
  e.classList.remove('at-start', 'at-end');
  e.classList.add(where, 'show');
  clearTimeout(edgeHintTimer);
  edgeHintTimer = setTimeout(() => e.classList.remove('show'), 1200);
}

// ---------- Sidebar ----------
async function loadState() {
  const s = await api.get('/api/state');
  state.feeds = s.feeds; state.categories = s.categories;
  $('#count-all').textContent = s.totals.unread || '';
  $('#count-readlater').textContent = s.totals.starred || '';
  renderTree();
  highlightSelection();
  updateHealthIndicator();
}

// A Google Alerts feed (identified by its alerts feed URL, with a title fallback).
function isGoogleAlert(f) {
  return /google\.[a-z.]+\/alerts\/feeds\//i.test(f.feed_url || '') ||
         /^google alerts\b/i.test(f.title || '');
}

// Header warning icon. Hidden when every feed is Active. Two severities:
//   error (red)  — one or more feeds Unreachable (fetch failing + gone stale)
//   warn  (yellow) — no Unreachable, but one or more feeds Inactive for *twice*
//                    the configured window (a single window is too noisy to alert on).
// Shows the higher severity; click jumps to Settings filtered to those feeds.
function updateHealthIndicator() {
  const btn = $('#health-btn');
  if (!btn) return;
  const months = Number(state.settings.inactive_months) || 9;
  const longStaleMs = 2 * months * 30.44 * 864e5; // twice the inactive window
  let unreachable = 0, inactive = 0;
  for (const f of state.feeds) {
    // Google Alerts feeds are quiet by nature (they only update when there's a
    // matching hit) — excluded from the health warning so they don't false-alarm.
    if (isGoogleAlert(f)) continue;
    const k = feedStatus(f).key;
    if (k === 'unreachable') { unreachable++; continue; }
    if (k !== 'inactive') continue;
    const newest = f.newest ? new Date(f.newest).getTime() : 0;
    const age = newest ? Date.now() - newest : Infinity;
    if (age > longStaleMs) inactive++;
  }
  btn.classList.remove('warn', 'error');
  if (!unreachable && !inactive) { btn.hidden = true; return; }

  const parts = [];
  if (unreachable) parts.push(t('health.unreachable', unreachable));
  if (inactive) parts.push(t('health.inactive', inactive));
  const severity = unreachable ? 'error' : 'warn';
  btn.classList.add(severity);
  btn.title = t('health.title', parts.join(', '));
  btn.dataset.jump = unreachable ? 'unreachable' : 'inactive';
  btn.hidden = false;
}

function renderTree() {
  const tree = $('#feed-tree');
  tree.innerHTML = '';
  const byCat = new Map();
  byCat.set(null, []);
  for (const c of state.categories) byCat.set(c.id, []);
  for (const f of state.feeds) {
    if (!byCat.has(f.category_id)) byCat.set(null, byCat.get(null));
    (byCat.get(f.category_id) || byCat.get(null)).push(f);
  }

  for (const cat of state.categories) {
    const feeds = byCat.get(cat.id) || [];
    if (!feeds.length) continue;
    tree.append(catBlock(cat.name, cat.id, feeds));
  }
  const uncat = byCat.get(null) || [];
  if (uncat.length) tree.append(catBlock(t('nav.uncategorized'), null, uncat));
  updateCollapseToggle();
}

// Collapse keys for the categories currently rendered (those that have feeds).
function visibleCatKeys() {
  const byCat = new Map([[null, []]]);
  for (const c of state.categories) byCat.set(c.id, []);
  for (const f of state.feeds) (byCat.get(f.category_id) || byCat.get(null)).push(f);
  const keys = [];
  for (const c of state.categories) if ((byCat.get(c.id) || []).length) keys.push('cat-' + c.id);
  if ((byCat.get(null) || []).length) keys.push('cat-none');
  return keys;
}

function updateCollapseToggle() {
  const b = $('#collapse-toggle');
  if (!b) return;
  const keys = visibleCatKeys();
  const allCollapsed = keys.length > 0 && keys.every((k) => state.collapsed[k]);
  b.textContent = allCollapsed ? '⊞' : '⊟';
  b.title = allCollapsed ? t('btn.expandAll') : t('btn.collapseAll');
}

function toggleCollapseAll() {
  const keys = visibleCatKeys();
  const allCollapsed = keys.length > 0 && keys.every((k) => state.collapsed[k]);
  for (const k of keys) state.collapsed[k] = !allCollapsed; // all collapsed -> expand; otherwise collapse
  localStorage.setItem('collapsed', JSON.stringify(state.collapsed));
  renderTree();
  highlightSelection();
}

function catBlock(name, id, feeds) {
  const key = 'cat-' + (id ?? 'none');
  const unread = feeds.reduce((s, f) => s + f.unread, 0);
  const wrap = el('div', { className: 'cat' + (state.collapsed[key] ? ' collapsed' : '') });
  const head = el('div', { className: 'cat-head' });
  head.append(el('span', { className: 'twist', textContent: '▾' }), el('span', { textContent: name }));
  head.append(el('span', { className: 'count', textContent: unread || '', style: 'margin-left:auto' }));
  head.onclick = () => { state.collapsed[key] = !state.collapsed[key]; localStorage.setItem('collapsed', JSON.stringify(state.collapsed)); renderTree(); highlightSelection(); };
  // Clicking the category name (not toggling) selects the whole category
  head.querySelector('span:nth-child(2)').onclick = (e) => { e.stopPropagation(); if (id != null) select({ type: 'category', id, name }); };
  wrap.append(head);

  for (const f of feeds) {
    const row = el('div', { className: 'feed-row' + (feedStatus(f).key === 'unreachable' ? ' has-error' : ''), dataset: { feed: f.id } });
    row.append(el('span', { className: 'title', textContent: decodeEntities(f.title), title: f.last_error || f.feed_url }));
    row.append(el('span', { className: 'count', textContent: f.unread || '' }));
    // Unsubscribe is intentionally only in Settings, to avoid accidental removal here.
    row.onclick = () => select({ type: 'feed', id: f.id, name: f.title });
    wrap.append(row);
  }
  return wrap;
}

function highlightSelection() {
  document.querySelectorAll('.nav-item, .feed-row').forEach((n) => n.classList.remove('active'));
  if (state.selection.type === 'all' || state.selection.type === 'starred') {
    document.querySelector(`.nav-item[data-view="${state.selection.type}"]`)?.classList.add('active');
  } else if (state.selection.type === 'feed') {
    document.querySelector(`.feed-row[data-feed="${state.selection.id}"]`)?.classList.add('active');
  }
}

// ---------- Article stream ----------
let lastBrowseSelection = { type: 'all' }; // restored when the search box is cleared
function select(sel) {
  if (sel.type !== 'search') {
    lastBrowseSelection = sel;
    const box = $('#search-box');
    if (box && box.value) box.value = ''; // leaving search clears the box
  }
  state.selection = sel;
  highlightSelection();
  closeDrawer(); // on mobile, picking a category closes the drawer
  loadItems();
}

// Pagination: pages of PAGE items. Browse views use keyset pagination (`before`
// the oldest loaded date) because marking items read mutates the unread query —
// plain offsets would skip rows. Search results are stable, so offset is fine.
const PAGE = 100;
let streamHasMore = false;
let streamLoading = false;

function itemsUrl({ before = null, offset = 0 } = {}) {
  const sel = state.selection;
  const p = new URLSearchParams();
  p.set('limit', String(PAGE));
  if (sel.type === 'search') {
    p.set('q', sel.q);
    if (offset) p.set('offset', String(offset));
    return '/api/search?' + p;
  }
  if (sel.type === 'feed') p.set('feed_id', sel.id);
  if (sel.type === 'category') p.set('category_id', sel.id);
  p.set('filter', sel.type === 'starred' ? 'starred' : state.filter);
  if (before) p.set('before', before);
  return '/api/items?' + p;
}

async function loadItems() {
  const sel = state.selection;
  const titleMap = { all: t('nav.all'), starred: t('nav.readLater'), feed: sel.name, category: sel.name, search: sel.type === 'search' ? t('search.title', sel.q) : '' };
  $('#stream-title').textContent = decodeEntities(titleMap[sel.type] || t('nav.all')) + (state.filter === 'unread' && sel.type !== 'starred' && sel.type !== 'search' ? t('unreadSuffix') : '');
  // The unread/all filter isn't meaningful in the Read Later or search views.
  $('#filter-select').style.display = sel.type === 'starred' || sel.type === 'search' ? 'none' : '';

  const { items, has_more } = await api.get(itemsUrl());
  streamHasMore = !!has_more;
  streamLoading = false;
  state.items = items;
  state.current = null;
  renderStream();
  $('#stream').scrollTop = 0; // a fresh view always starts at the top
  const first = $('#stream').querySelector('.article');
  if (first) setFocus(Number(first.dataset.id)); // focus only — not read
}

// Fetch and append the next page (infinite scroll / j-past-the-end / swipe).
async function loadMore() {
  if (streamLoading || !streamHasMore || !state.items.length) return;
  streamLoading = true;
  try {
    const last = state.items[state.items.length - 1];
    const url = state.selection.type === 'search'
      ? itemsUrl({ offset: state.items.length })
      : itemsUrl({ before: last.published_at || last.fetched_at });
    const { items, has_more } = await api.get(url);
    streamHasMore = !!has_more;
    const have = new Set(state.items.map((i) => i.id));
    const fresh = items.filter((i) => !have.has(i.id));
    if (fresh.length) {
      state.items = [...state.items, ...fresh];
      const stream = $('#stream');
      const mobile = isMobile();
      for (const it of fresh) stream.append(mobile ? buildListItem(it) : buildArticle(it));
      if (!mobile) observeImages();
    } else if (!items.length) {
      streamHasMore = false; // server says nothing further
    }
  } catch { /* transient; retried on next scroll */ }
  finally { streamLoading = false; }
}

// Friendly edge card (icon + title + optional hint). Reused by the empty view
// and the mobile swipe-past-the-ends terminal cards. `icon` may be an emoji
// string or an icon DOM node (e.g. an <img> for an SVG).
function buildEdgeCard(icon, title, sub) {
  const iconNode = typeof icon === 'string'
    ? el('div', { className: 'all-read-emoji', textContent: icon })
    : icon;
  const kids = [iconNode, el('div', { className: 'all-read-title', textContent: title })];
  if (sub) kids.push(el('div', { className: 'all-read-sub', textContent: sub }));
  return el('div', { className: 'empty all-read' }, ...kids);
}
function buildAllReadCard(sub) {
  const icon = el('img', { className: 'all-read-img', src: '/icons/all-read.png', alt: '' });
  return buildEdgeCard(icon, t('card.allRead'), sub);
}

function renderStream() {
  const stream = $('#stream');
  stream.innerHTML = '';
  if (!state.items.length) {
    // Empty search = "no results", not the celebratory all-read card.
    stream.append(state.selection.type === 'search'
      ? el('div', { className: 'empty', textContent: t('search.none') })
      : buildAllReadCard());
    return;
  }
  if (isMobile()) {
    for (const it of state.items) stream.append(buildListItem(it));
  } else {
    for (const it of state.items) stream.append(buildArticle(it));
    observeImages();
  }
}

function buildArticle(it) {
  const card = el('article', { className: 'article' + (it.is_read ? ' read' : ''), dataset: { id: it.id } });

  const openRead = () => { if (!it.is_read) markRead(it, true); }; // opening the article counts as read

  const title = decodeEntities(it.title);
  const h = el('h1', { className: 'article-title' });
  if (it.link) h.append(el('a', { href: it.link, target: '_blank', rel: 'noopener noreferrer', textContent: title, onclick: openRead }));
  else h.textContent = title;
  card.append(h);

  // Meta row: feed name / byline / time on the left, action buttons on the right.
  const meta = el('div', { className: 'article-meta' });
  const info = el('div', { className: 'article-meta-info' });
  info.append(el('span', { textContent: decodeEntities(it.feed_title) }));
  if (it.author) info.append(el('span', { textContent: '· ' + decodeEntities(it.author) }));
  info.append(el('span', { textContent: '· ' + fmtDate(it.published_at || it.fetched_at) }));
  meta.append(info);

  const actions = el('div', { className: 'article-actions' });
  const save = el('button', { className: 'save' + (it.is_starred ? ' on' : ''), textContent: it.is_starred ? t('item.saved') : t('item.readLater') });
  save.onclick = (e) => { e.stopPropagation(); toggleSaved(it, save); };
  const mark = el('button', { className: 'mark', textContent: it.is_read ? t('item.markUnread') : t('item.markRead') });
  mark.onclick = (e) => { e.stopPropagation(); markRead(it, !it.is_read); };
  actions.append(save, mark);
  meta.append(actions);
  card.append(meta);

  const body = el('div', { className: 'article-body' });
  body.innerHTML = sanitize(it.content || it.summary || `<p><em>${t('item.noContent')}</em></p>`);
  card.append(body);

  // "Open original" sits at the bottom, centered, taking about a third of the width.
  if (it.link) {
    const foot = el('div', { className: 'article-foot' });
    foot.append(el('a', { className: 'open-original', href: it.link, target: '_blank', rel: 'noopener', textContent: t('item.openOriginal'), onclick: openRead }));
    card.append(foot);
  }

  // Clicking the card (not a link/button) focuses it as the current article.
  card.addEventListener('click', (e) => { if (!e.target.closest('a, button')) setActive(it.id, { scroll: false }); });
  // No image in the feed content? Mark it to lazily fetch one from the original.
  if (it.link && !/<img\b/i.test(it.content || '')) card.dataset.needsImage = '1';
  return card;
}

// Lead images (the original page's og:image) for imageless articles are fetched
// as they near the viewport, and we preload a few articles ahead so they're
// ready before you scroll to them.
const PRELOAD_AHEAD = 5;
let imgObserver = null;
function observeImages() {
  if (typeof IntersectionObserver === 'undefined') return;
  if (!imgObserver) {
    imgObserver = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { imgObserver.unobserve(e.target); loadLeadImage(e.target); }
    }, { root: $('#stream'), rootMargin: '300px' });
  }
  $('#stream').querySelectorAll('.article[data-needs-image]').forEach((c) => imgObserver.observe(c));
}

// Load a card's lead image, then warm the next few cards' images. `cascade`
// guards against the preload chain running away past the lookahead window.
async function loadLeadImage(card, cascade = true) {
  if (!card || card.dataset.needsImage == null) return; // already handled
  delete card.dataset.needsImage;
  if (cascade) preloadAhead(card);
  let image_url;
  try { ({ image_url } = await api.get('/api/items/' + Number(card.dataset.id) + '/image')); } catch { return; }
  if (!image_url) return;
  // Place the image below the feed name/byline so the source stays under the title.
  const anchor = card.querySelector('.article-meta') || card.querySelector('.article-title');
  // No loading="lazy": insertion timing already gates this, and ahead-of-viewport
  // cards should download now so they're ready when scrolled to.
  if (anchor && !card.querySelector('.lead-img')) {
    anchor.after(el('img', { className: 'lead-img', src: image_url, alt: '' }));
  }
}

// Eagerly load the next PRELOAD_AHEAD imageless cards after `card` (no further cascade).
function preloadAhead(card) {
  let n = 0, c = card.nextElementSibling;
  while (c && n < PRELOAD_AHEAD) {
    if (c.classList && c.classList.contains('article') && c.dataset.needsImage != null) {
      loadLeadImage(c, false);
      n++;
    }
    c = c.nextElementSibling;
  }
}

// Warm an item's lead image into the server + browser cache (used on mobile,
// where each article view is built on demand when you tap/swipe).
function preloadItemImage(it) {
  if (!it || !it.link || /<img\b/i.test(it.content || '')) return;
  api.get('/api/items/' + it.id + '/image').then((r) => { if (r && r.image_url) { const im = new Image(); im.src = r.image_url; } }).catch(() => {});
}

// ---------- Mobile: summary list, single-article view, drawer ----------
function buildListItem(it) {
  const node = el('div', { className: 'litem' + (it.is_read ? ' read' : ''), dataset: { id: it.id } });
  node.append(el('div', { className: 'litem-title', textContent: decodeEntities(it.title) }));
  node.append(el('div', { className: 'litem-meta', textContent: decodeEntities(it.feed_title) + ' · ' + fmtDate(it.published_at || it.fetched_at) }));
  const snip = (it.summary || '').trim();
  if (snip) node.append(el('div', { className: 'litem-snip', textContent: decodeEntities(snip) }));
  node.onclick = () => openMobileArticle(it.id);
  return node;
}

function openMobileArticle(id) {
  const it = state.items.find((x) => x.id === id);
  if (!it) return;
  state.mobileEnd = false;
  state.mobileStart = false;
  state.current = it;
  const view = $('#article-view');
  const body = view.querySelector('.av-body');
  body.innerHTML = '';
  const card = buildArticle(it);
  body.append(card);
  if (card.dataset.needsImage) loadLeadImage(card, false); // single visible article: load now
  $('#av-feed').textContent = decodeEntities(it.feed_title || '');
  body.scrollTop = 0;
  view.classList.add('open');
  if (!it.is_read) markRead(it, true); // viewing = read
  // Preload the next couple of articles' images so a swipe shows them instantly.
  const idx = state.items.findIndex((x) => x.id === id);
  for (let k = 1; k <= 2; k++) preloadItemImage(state.items[idx + k]);
}
function closeMobileArticle() { state.mobileEnd = false; state.mobileStart = false; $('#article-view').classList.remove('open'); }

// Terminal "All read" card shown after swiping past the last article.
function showMobileEndCard() {
  state.mobileEnd = true; state.mobileStart = false;
  showMobileCard(buildAllReadCard(t('card.allReadSub')));
}
// Terminal "At start" card shown after swiping before the first article.
function showMobileStartCard() {
  state.mobileStart = true; state.mobileEnd = false;
  showMobileCard(buildEdgeCard('⏮', t('card.atStart'), t('card.atStartSub')));
}
function showMobileCard(card) {
  const view = $('#article-view');
  const body = view.querySelector('.av-body');
  body.innerHTML = '';
  body.append(card);
  $('#av-feed').textContent = '';
  body.scrollTop = 0;
  view.classList.add('open');
}

function mobileNav(dir) { // dir: +1 next, -1 previous
  // On a terminal card, swipe back toward the articles; the other way stays put.
  if (state.mobileEnd) {
    if (dir < 0) { const last = state.items[state.items.length - 1]; if (last) openMobileArticle(last.id); }
    return;
  }
  if (state.mobileStart) {
    if (dir > 0) { const first = state.items[0]; if (first) openMobileArticle(first.id); }
    return;
  }
  const idx = state.items.findIndex((x) => x.id === state.current?.id);
  const n = state.items[idx + dir];
  if (n) openMobileArticle(n.id);
  else if (dir > 0) {
    if (streamHasMore) {
      // More pages exist — fetch, then advance (or show the end card if truly done).
      loadMore().then(() => {
        const i2 = state.items.findIndex((x) => x.id === state.current?.id);
        const nn = state.items[i2 + 1];
        if (nn) openMobileArticle(nn.id); else showMobileEndCard();
      });
    } else showMobileEndCard();            // swiped past the last article
  } else showMobileStartCard();            // swiped before the first article
}

function openDrawer() { $('#app').classList.add('drawer-open'); }
function closeDrawer() { $('#app').classList.remove('drawer-open'); }

// ---------- Active article tracking ----------
// Focus = the article highlighted at the top of the view. No read side-effect.
function setFocus(id) {
  const it = state.items.find((x) => x.id === id);
  if (!it) return;
  state.current = it;
  $('#stream').querySelectorAll('.article').forEach((n) => n.classList.toggle('active', Number(n.dataset.id) === id));
}

function setActive(id, { scroll = false } = {}) {
  setFocus(id);
  if (scroll) scrollActiveIntoView(id);
}

// Pin the focused article near the top of the stream (keyboard navigation).
function scrollActiveIntoView(id) {
  const stream = $('#stream');
  const node = stream && stream.querySelector(`.article[data-id="${id}"]`);
  if (!stream || !node) return;
  stream.scrollTop += node.getBoundingClientRect().top - stream.getBoundingClientRect().top - 8;
}

// Read model: mark an article read only once it has been scrolled fully ABOVE
// the top of the view (you've moved past it). Programmatic scrolls from
// auto-refresh are suppressed, so they never mark anything read.
let suppressScrollRead = false;
let scrollScheduled = false;
function onStreamScroll() {
  if (scrollScheduled) return;
  scrollScheduled = true;
  requestAnimationFrame(() => {
    scrollScheduled = false;
    const stream = $('#stream');
    const rect = stream.getBoundingClientRect();
    const streamTop = rect.top, streamBottom = rect.bottom;
    const focusLine = streamTop + 80;
    // Infinite scroll: start fetching the next page well before the bottom.
    if (stream.scrollTop + stream.clientHeight >= stream.scrollHeight - 600) loadMore();
    // The last article(s) can't be scrolled past, so reaching the very bottom
    // marks whatever's still on screen as read — but only at the TRUE end
    // (no further pages), otherwise the tail of each page would get marked.
    const atEnd = !streamHasMore && stream.scrollTop + stream.clientHeight >= stream.scrollHeight - 4;
    let focus = null;
    for (const node of stream.querySelectorAll('.article')) {
      const r = node.getBoundingClientRect();
      const pastTop = r.bottom <= streamTop + 4;                          // scrolled fully past the top
      const visibleAtEnd = atEnd && r.top < streamBottom && r.bottom > streamTop; // on screen at the end
      if (!suppressScrollRead && (pastTop || visibleAtEnd)) {
        const it = state.items.find((x) => x.id === Number(node.dataset.id));
        if (it && !it.is_read) markRead(it, true);
      }
      if (r.top <= focusLine) focus = node; // topmost still in view = focus
    }
    if (focus && state.current?.id !== Number(focus.dataset.id)) setFocus(Number(focus.dataset.id));
  });
}

// Embed hosts that actually permit being framed (so their players still work).
const EMBED_OK = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be|player\.vimeo\.com|w\.soundcloud\.com|open\.spotify\.com|bandcamp\.com|player\.twitch\.tv|dailymotion\.com)$/i;

// Light sanitize: strip active/markup-injection vectors and inline event handlers.
// (Single-user, trusted feeds — but feed authors are still third parties.)
const DANGEROUS_SCHEME = /^\s*(javascript|data|vbscript):/i;
function sanitize(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // Remove elements that can execute code or hijack relative-URL resolution.
  doc.querySelectorAll('script, style, link, meta, base, object, embed, form').forEach((n) => n.remove());
  doc.querySelectorAll('*').forEach((n) => {
    for (const a of [...n.attributes]) {
      const name = a.name.toLowerCase();
      // Inline event handlers, and any URL-bearing attribute with a dangerous scheme.
      if (/^on/i.test(name) || name === 'srcdoc' || name === 'formaction') { n.removeAttribute(a.name); continue; }
      if ((name === 'href' || name === 'src' || name === 'xlink:href') && DANGEROUS_SCHEME.test(a.value)) n.removeAttribute(a.name);
    }
  });
  // Most feed iframes (Slashdot's discussion widget, ad/track frames) set
  // X-Frame-Options and can't be embedded cross-origin — they'd render as a
  // browser security error. Keep known-embeddable players; turn the rest into a
  // link that opens in a new tab (which is what the browser warning suggests).
  doc.querySelectorAll('iframe').forEach((f) => {
    const raw = f.getAttribute('src') || '';
    let host = '';
    try { host = new URL(raw, 'https://_').hostname; } catch { /* leave host empty */ }
    if (host && EMBED_OK.test(host)) { f.setAttribute('loading', 'lazy'); return; }
    const p = doc.createElement('p');
    if (raw) {
      const a = doc.createElement('a');
      a.href = raw; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.textContent = t('embed.openTab');
      p.appendChild(a);
    } else {
      p.textContent = t('embed.removed');
    }
    f.replaceWith(p);
  });
  doc.querySelectorAll('a').forEach((a) => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
  return doc.body.innerHTML;
}

// Sidebar counts update is debounced so scroll-driven read marking stays cheap.
let countsTimer;
function refreshCountsSoon() { clearTimeout(countsTimer); countsTimer = setTimeout(() => loadState(), 700); }

function markRead(it, read) {
  it.is_read = read ? 1 : 0;
  api.post(`/api/items/${it.id}/read`, { read: !!read }).catch(() => {});
  // Update every place the item is shown: stream cards, mobile list items, the article view.
  document.querySelectorAll(`.article[data-id="${it.id}"], .litem[data-id="${it.id}"]`).forEach((card) => {
    card.classList.toggle('read', !!it.is_read);
    const btn = card.querySelector('.mark');
    if (btn) btn.textContent = it.is_read ? t('item.markUnread') : t('item.markRead');
  });
  refreshCountsSoon();
}

function toggleSaved(it, btn) {
  it.is_starred = it.is_starred ? 0 : 1;
  api.post(`/api/items/${it.id}/star`, { starred: !!it.is_starred }).catch(() => {});
  btn.classList.toggle('on', !!it.is_starred);
  btn.textContent = it.is_starred ? t('item.saved') : t('item.readLater');
  refreshCountsSoon();
}

// ---------- Reload (no fetch) & auto-refresh ----------
// Manual reload: re-render the current view from the DB (does NOT fetch feeds).
async function reloadView() {
  const btn = $('#reload-btn'); btn.classList.add('spin');
  try { await loadState(); await loadItems(); }
  finally { btn.classList.remove('spin'); }
}

// Auto-refresh: pull newly-available items into the current view without
// re-rendering or dropping what you're reading, keeping scroll position stable.
// Mode-aware: desktop prepends full article cards, mobile prepends list items.
async function refreshStream() {
  if (state.selection.type === 'search') return; // search results are a stable snapshot
  await loadState();
  let items;
  try { ({ items } = await api.get(itemsUrl())); } catch { return; }
  const stream = $('#stream');
  const mobile = isMobile();
  const cardSel = mobile ? '.litem' : '.article';
  const have = new Set([...stream.querySelectorAll(cardSel)].map((n) => Number(n.dataset.id)));
  const fresh = items.filter((i) => !have.has(i.id));
  if (!fresh.length) return;
  if (!have.size) {
    // View was empty (the "All read" card) — replace it with a full render.
    state.items = items;
    renderStream();
    return;
  }
  const before = stream.scrollTop;
  const wasAtTop = before <= 4;
  const firstCard = stream.querySelector(cardSel);
  const anchorTop = firstCard ? firstCard.getBoundingClientRect().top : 0;
  suppressScrollRead = true; // our scroll adjustment below must not mark anything read
  for (const it of [...fresh].reverse()) stream.prepend(mobile ? buildListItem(it) : buildArticle(it)); // newest on top, in order
  // Keep articles already shown (even if since read) so j/k navigation still works.
  state.items = [...fresh, ...state.items];
  if (wasAtTop) {
    // At the top: surface the new articles and *stay pinned* to the top. A plain
    // scrollTop=0 isn't enough — the new cards load their lead images a moment
    // later, and that reflow otherwise leaves the view a few px below the top.
    if (!mobile) {
      const nf = stream.querySelector(cardSel);
      if (nf) setFocus(Number(nf.dataset.id));
    }
    pinStreamTop(stream);
  } else if (firstCard) {
    // Mid-read: keep the current position steady as content is added above.
    stream.scrollTop = before + (firstCard.getBoundingClientRect().top - anchorTop);
  }
  if (!mobile) observeImages();
  setTimeout(() => { suppressScrollRead = false; }, 500);
}

// Hold the stream at the very top for a short window so async lead-image reflow
// in freshly-added cards can't drift the view down. Yields the instant the user
// scrolls or interacts.
function pinStreamTop(stream) {
  stream.scrollTop = 0;
  let cancelled = false;
  const evs = ['wheel', 'touchmove', 'keydown', 'pointerdown'];
  const cancel = () => { cancelled = true; evs.forEach((e) => window.removeEventListener(e, cancel, true)); };
  evs.forEach((e) => window.addEventListener(e, cancel, true));
  const end = performance.now() + 500;
  const tick = () => {
    if (cancelled) return;
    if (stream.scrollTop !== 0) stream.scrollTop = 0;
    if (performance.now() < end) requestAnimationFrame(tick);
    else cancel();
  };
  requestAnimationFrame(tick);
}

let autoTimer = null;
function startAutoRefresh() {
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  const secs = Number(state.settings.autorefresh_seconds);
  if (secs > 0) autoTimer = setInterval(() => { refreshStream().catch(() => {}); }, secs * 1000);
}

// ---------- Add feed (discover -> choose) ----------
async function addFeed() {
  const input = $('#add-url');
  const url = input.value.trim();
  if (!url) return;
  await runAdd(url, $('#add-btn'));
  input.value = '';
}

// Shared add flow: discover, then auto-add or show the candidate chooser.
async function runAdd(url, btn) {
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    const res = await api.post('/api/discover', { url });
    if (res.candidates.length === 1 && !res.scrape) {
      await confirmAdd({ feed_url: res.candidates[0].feedUrl, title: res.candidates[0].title });
    } else {
      showAddModal(url, res);
    }
  } catch (e) {
    toast(t('toast.couldNotReach', e.message));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

function showAddModal(url, res) {
  const bg = el('div', { className: 'modal-bg' });
  const m = el('div', { className: 'modal' });
  m.append(el('h3', { textContent: t('add.title') }));
  let choice = null;

  const choices = el('div');
  const pick = (row, c) => {
    choices.querySelectorAll('.choice').forEach((x) => x.classList.remove('sel'));
    row.classList.add('sel');
    choice = c;
    modeRow.hidden = c.kind !== 'scrape'; // scrape mode only applies to scraped pages
  };
  res.candidates.forEach((c, i) => {
    const row = el('div', { className: 'choice' + (i === 0 ? ' sel' : '') });
    row.append(el('div', {}, el('strong', { textContent: c.title }), el('div', { style: 'font-size:12px;color:var(--muted)', textContent: c.feedUrl })));
    row.onclick = () => pick(row, { feed_url: c.feedUrl, title: c.title });
    choices.append(row);
    if (i === 0) choice = { feed_url: c.feedUrl, title: c.title };
  });
  if (res.scrape) {
    const row = el('div', { className: 'choice' + (res.candidates.length ? '' : ' sel') });
    row.append(el('div', {}, el('strong', { textContent: t('add.scrapeTitle') }), el('div', { style: 'font-size:12px;color:var(--muted)', textContent: t('add.scrapeDesc', res.scrape.title) })));
    row.onclick = () => pick(row, { kind: 'scrape', source_url: res.scrape.sourceUrl, title: res.scrape.title });
    choices.append(row);
    if (!res.candidates.length) choice = { kind: 'scrape', source_url: res.scrape.sourceUrl, title: res.scrape.title };
  }
  m.append(choices);

  // How to read a scraped page (newsletter = single article vs link list) —
  // choosable up front instead of only after the fact in Edit.
  const modeRow = el('div');
  modeRow.append(el('label', { className: 'flbl', textContent: t('edit.howToRead') }));
  const modeSel = el('select', { className: 'mode-select' });
  [['auto', t('edit.modeAuto')], ['page', t('edit.modePage')], ['links', t('edit.modeLinks')]]
    .forEach(([v, lbl]) => modeSel.append(el('option', { value: v, textContent: lbl })));
  modeRow.append(modeSel);
  modeRow.append(el('p', { className: 'modal-warn', textContent: t('edit.modeHint') }));
  modeRow.hidden = !(choice && choice.kind === 'scrape');
  m.append(modeRow);

  // Category: dropdown of existing categories, plus a "new category" option
  // that reveals a name field.
  m.append(el('label', { className: 'flbl', textContent: t('add.category') }));
  const catSel = el('select', { className: 'mode-select' });
  catSel.append(el('option', { value: '', textContent: t('nav.uncategorized') }));
  state.categories.forEach((c) => catSel.append(el('option', { value: c.name, textContent: c.name })));
  const newOpt = el('option', { value: '', textContent: t('add.catNew') });
  newOpt.dataset.new = '1';
  catSel.append(newOpt);
  const newCat = el('input', { type: 'text', placeholder: t('settings.newCatPh'), hidden: true });
  catSel.onchange = () => {
    const isNew = catSel.selectedOptions[0]?.dataset.new === '1';
    newCat.hidden = !isNew;
    if (isNew) newCat.focus();
  };
  m.append(catSel, newCat);

  const actions = el('div', { className: 'modal-actions' });
  const cancel = el('button', { textContent: t('btn.cancel') }); cancel.onclick = () => bg.remove();
  const ok = el('button', { className: 'primary', textContent: t('btn.subscribe') });
  ok.onclick = async () => {
    ok.disabled = true; ok.textContent = '…';
    const isNew = catSel.selectedOptions[0]?.dataset.new === '1';
    const category = (isNew ? newCat.value.trim() : catSel.value) || undefined;
    const payload = { ...choice, category };
    if (choice.kind === 'scrape') payload.scrape_mode = modeSel.value;
    await confirmAdd(payload);
    bg.remove();
  };
  actions.append(cancel, ok);
  m.append(actions);
  bg.append(m); bg.onclick = (e) => { if (e.target === bg) bg.remove(); };
  document.body.append(bg);
}

async function confirmAdd(payload) {
  try {
    await api.post('/api/feeds', payload);
    toast(t('toast.subscribed'));
    await afterChange();
  } catch (e) {
    if (e.status === 409 && e.data?.scrape) {
      if (confirm(t('confirm.scrapeInstead'))) {
        await api.post('/api/feeds', { kind: 'scrape', source_url: e.data.scrape.sourceUrl, title: e.data.scrape.title });
        toast(t('toast.subscribedScraped')); await afterChange();
      }
    } else toast(t('toast.failed', e.message));
  }
}

// Reload sidebar + item list, and the settings panel if it's open.
async function afterChange() {
  await loadState();
  await loadItems();
  if (settingsEl) await renderSettings();
}

// ---------- Misc actions ----------
async function refreshAll() {
  const btn = $('#refresh-btn'); btn.classList.add('spin');
  try { const r = await api.post('/api/refresh'); toast(t('toast.refreshed', r.added)); await loadState(); await loadItems(); }
  catch (e) { toast(t('toast.refreshFailed')); }
  finally { btn.classList.remove('spin'); }
}

async function markAllRead(olderThan) {
  const sel = state.selection;
  const body = sel.type === 'feed' ? { feed_id: sel.id } : sel.type === 'category' ? { category_id: sel.id } : {};
  if (olderThan && olderThan !== 'all') body.older_than = olderThan;
  try {
    const r = await api.post('/api/items/read-all', body);
    toast(t('toast.marked', r.marked)); await loadState(); await loadItems();
  } catch (e) {
    toast(t('toast.markFailed', e.message));
  }
}

async function importOpml(file) {
  try {
    const text = await file.text();
    const r = await fetch('/api/opml/import', { method: 'POST', headers: { 'Content-Type': 'application/xml' }, body: text });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || r.status);
    toast(t('toast.imported', data.feeds));
    await loadState();
    refreshAll();
  } catch (e) {
    toast(t('toast.opmlFailed', e.message));
  }
}

function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s); const now = Date.now(); const diff = (now - d) / 1000;
  if (diff < 60) return t('date.justNow');
  if (diff < 3600) return t('date.mAgo', Math.floor(diff / 60));
  if (diff < 86400) return t('date.hAgo', Math.floor(diff / 3600));
  if (diff < 604800) return t('date.dAgo', Math.floor(diff / 86400));
  return d.toLocaleDateString(curLocale(), { month: 'short', day: 'numeric' });
}

// ---------- Settings panel (subscriptions, categories, health) ----------
let settingsEl = null;
let settingsData = null;          // cached /api/feeds/detail payload
let settingsStatusFilter = 'all'; // 'all' | 'active' | 'inactive' | 'unreachable'
let settingsSearch = '';          // live text filter for the feed list
// Category filter for the feed list: 'all', a category name, or CAT_UNFILED.
// (A Symbol sentinel — a real category could be literally named "none".)
const CAT_UNFILED = Symbol('uncategorized');
let settingsCatFilter = 'all';
// Per-category collapse state for the settings feed list (default: expanded).
let settingsCollapsed = lsJSON('settingsCollapsed', {});

// Each status is shape-coded as well as color-coded (deuteranope-safe).
const STATUS_GLYPH = { active: '●', inactive: '◆', unreachable: '▲' };

// Classify a feed: unreachable (last fetch errored), inactive (nothing new
// within the configured window, or no items), or active.
function feedStatus(f) {
  const newest = f.newest ? new Date(f.newest).getTime() : 0;
  const age = newest ? Date.now() - newest : Infinity;
  const months = Number(state.settings.inactive_months) || 9;
  const cutoffMs = months * 30.44 * 864e5; // average days per month
  // A last-fetch error on a feed that's still delivering fresh content (within
  // ~2 days) is almost always transient — e.g. Reddit rate-limiting (429/403) —
  // so don't flag it unreachable. Only feeds erroring AND going stale qualify.
  if (f.last_error && age > 2 * 864e5) return { key: 'unreachable', label: t('status.unreachable') };
  if (age > cutoffMs) {
    if (!newest) return { key: 'inactive', label: t('status.inactiveNoItems') };
    const since = new Date(newest).toLocaleDateString(curLocale(), { year: 'numeric', month: 'short', day: 'numeric' });
    const m = Math.round(age / (30.44 * 864e5));
    return { key: 'inactive', label: t('status.inactiveSince', since, m) };
  }
  return { key: 'active', label: t('status.active') };
}

// A clickable status filter chip (with shape glyph + count).
function filterChip(key, label, count, selected, onClick) {
  const c = el('button', { className: 'status-chip' + (selected ? ' sel' : '') });
  if (STATUS_GLYPH[key]) c.append(el('span', { className: 'sdot ' + key, textContent: STATUS_GLYPH[key] }));
  c.append(el('span', { textContent: `${label} (${count})` }));
  c.onclick = onClick;
  return c;
}

async function openSettings(initialFilter = 'all') {
  if (settingsEl) return;
  settingsStatusFilter = initialFilter;
  settingsSearch = '';
  settingsCatFilter = 'all';
  const bg = el('div', { className: 'modal-bg' });
  bg.append(el('div', { className: 'modal wide' }));
  bg.onclick = (e) => { if (e.target === bg) closeSettings(); };
  document.body.append(bg);
  settingsEl = bg;
  await renderSettings();
}
function closeSettings() { settingsEl?.remove(); settingsEl = null; settingsData = null; }

// ---------- Security section (account, 2FA) ----------
function authErrMsg(code) {
  const k = 'security.err.' + code;
  const m = t(k);
  return m === k ? t('toast.failed', code || '') : m;
}
async function doLogout() {
  try { await api.post('/api/logout'); } catch { /* ignore */ }
  location.href = '/login';
}
// A small modal shell: returns { m, close }. `m` is the content box.
function authModal(titleKey) {
  const bg = el('div', { className: 'modal-bg' });
  const m = el('div', { className: 'modal' });
  m.append(el('h3', { textContent: t(titleKey) }));
  const close = () => bg.remove();
  bg.append(m);
  bg.onclick = (e) => { if (e.target === bg) close(); };
  document.body.append(bg);
  return { m, close };
}
// Modal that lists recovery codes once, with copy/download.
function showRecoveryCodes(codes) {
  const { m, close } = authModal('security.recoveryTitle');
  m.append(el('p', { className: 'modal-warn', textContent: t('security.recoveryIntro') }));
  const list = el('div', { className: 'recovery-codes' });
  for (const c of codes) list.append(el('div', { textContent: c }));
  m.append(list);
  const actions = el('div', { className: 'modal-actions' });
  const copy = el('button', { textContent: t('security.copy') });
  copy.onclick = async () => { try { await navigator.clipboard.writeText(codes.join('\n')); copy.textContent = t('security.copied'); } catch { /* ignore */ } };
  const dl = el('button', { textContent: t('security.download') });
  dl.onclick = () => {
    const blob = new Blob([codes.join('\n') + '\n'], { type: 'text/plain' });
    const a = el('a', { href: URL.createObjectURL(blob), download: 'vectorhome-recovery-codes.txt' });
    a.click(); URL.revokeObjectURL(a.href);
  };
  const done = el('button', { className: 'primary', textContent: t('security.done') });
  done.onclick = close;
  actions.append(copy, dl, done);
  m.append(actions);
}
// Password-confirm modal used by disable / regenerate. Calls `onSubmit(password)`.
function passwordPrompt(titleKey, introKey, onSubmit) {
  const { m, close } = authModal(titleKey);
  m.append(el('p', { className: 'modal-warn', textContent: t(introKey) }));
  m.append(el('label', { className: 'flbl', textContent: t('security.password') }));
  const pw = el('input', { type: 'password', autocomplete: 'current-password' });
  m.append(pw);
  const err = el('div', { className: 'fsub err', style: 'min-height:16px' });
  m.append(err);
  const actions = el('div', { className: 'modal-actions' });
  const cancel = el('button', { textContent: t('btn.cancel') }); cancel.onclick = close;
  const ok = el('button', { className: 'primary', textContent: t('security.confirm') });
  ok.onclick = async () => {
    ok.disabled = true; err.textContent = '';
    try { await onSubmit(pw.value); close(); }
    catch (e) { ok.disabled = false; err.textContent = authErrMsg(e.message); }
  };
  actions.append(cancel, ok);
  m.append(actions);
  pw.focus();
}

function renderSecuritySection(body) {
  const sec = el('div', { className: 'settings-section' });
  sec.append(el('h4', { textContent: t('security.title') }));
  sec.append(el('div', { className: 'settings-row', textContent: '…' }));
  body.append(sec);
  api.get('/api/auth/status').then((st) => paintSecurity(sec, st)).catch(() => sec.remove());
}
function paintSecurity(sec, st) {
  sec.innerHTML = '';
  sec.append(el('h4', { textContent: t('security.title') }));

  const row1 = el('div', { className: 'settings-row' });
  row1.append(el('span', { textContent: t('security.user') + ': ' }), el('strong', { textContent: st.username }));
  const logout = el('button', { className: 'fbtn', textContent: t('security.logout'), style: 'margin-left:auto' });
  logout.onclick = doLogout;
  row1.append(logout);
  sec.append(row1);

  const row2 = el('div', { className: 'settings-row' });
  row2.append(el('span', { textContent: t('security.2fa') + ': ' }),
    el('strong', { textContent: st.totp_enabled ? t('security.2faOn') : t('security.2faOff') }));
  sec.append(row2);

  const row3 = el('div', { className: 'settings-row' });
  if (st.totp_enabled) {
    row3.append(el('span', { className: 'fsub', textContent: t('security.recoveryLeft', st.recovery_remaining) }));
    const regen = el('button', { className: 'fbtn', textContent: t('security.regen'), style: 'margin-left:auto' });
    regen.onclick = () => passwordPrompt('security.regen', 'security.confirmRegen', async (password) => {
      const r = await api.post('/api/auth/recovery', { password });
      showRecoveryCodes(r.recovery); refreshSecurity(sec);
    });
    const dis = el('button', { className: 'fbtn unsub', textContent: t('security.disable') });
    dis.onclick = () => passwordPrompt('security.disable', 'security.confirmDisable', async (password) => {
      await api.post('/api/auth/totp/disable', { password }); refreshSecurity(sec);
    });
    row3.append(regen, dis);
  } else {
    const en = el('button', { className: 'fbtn', textContent: t('security.enable') });
    en.onclick = () => enable2faFlow(sec);
    row3.append(en);
  }
  sec.append(row3);

  const pwBtn = el('button', { className: 'fbtn', textContent: t('security.changePw') });
  pwBtn.onclick = changePasswordFlow;
  sec.append(el('div', { className: 'settings-row' }, pwBtn));
}
function refreshSecurity(sec) { api.get('/api/auth/status').then((st) => paintSecurity(sec, st)).catch(() => {}); }

async function enable2faFlow(sec) {
  let setup;
  try { setup = await api.post('/api/auth/totp/setup'); } catch (e) { toast(t('toast.failed', e.message)); return; }
  const { m, close } = authModal('security.setupTitle');
  m.append(el('p', { className: 'modal-warn', textContent: t('security.setupIntro') }));
  // QR of the otpauth:// URI (vendored qrcode-generator; content is our own).
  if (typeof qrcode === 'function') {
    try {
      const qr = qrcode(0, 'M');
      qr.addData(setup.uri);
      qr.make();
      const box = el('div', { className: 'totp-qr' });
      box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
      m.append(box);
    } catch { /* URI too long for auto-type is not expected; fall back to text */ }
  }
  m.append(el('label', { className: 'flbl', textContent: t('security.secretKey') }));
  m.append(el('div', { className: 'totp-secret', textContent: setup.secret }));
  m.append(el('a', { className: 'totp-link', href: setup.uri, textContent: 'otpauth://…' }));
  m.append(el('label', { className: 'flbl', textContent: t('security.enterCode') }));
  const code = el('input', { type: 'text', inputmode: 'numeric', placeholder: '123456', autocomplete: 'one-time-code' });
  m.append(code);
  const err = el('div', { className: 'fsub err', style: 'min-height:16px' });
  m.append(err);
  const actions = el('div', { className: 'modal-actions' });
  const cancel = el('button', { textContent: t('btn.cancel') }); cancel.onclick = close;
  const ok = el('button', { className: 'primary', textContent: t('security.confirm') });
  ok.onclick = async () => {
    ok.disabled = true; err.textContent = '';
    try {
      const r = await api.post('/api/auth/totp/enable', { code: code.value });
      close(); showRecoveryCodes(r.recovery); refreshSecurity(sec);
    } catch (e) { ok.disabled = false; err.textContent = authErrMsg(e.message); }
  };
  actions.append(cancel, ok);
  m.append(actions);
  code.focus();
}

function changePasswordFlow() {
  const { m, close } = authModal('security.changePw');
  m.append(el('label', { className: 'flbl', textContent: t('security.current') }));
  const cur = el('input', { type: 'password', autocomplete: 'current-password' });
  m.append(cur);
  m.append(el('label', { className: 'flbl', textContent: t('security.new') }));
  const next = el('input', { type: 'password', autocomplete: 'new-password' });
  m.append(next);
  m.append(el('label', { className: 'flbl', textContent: t('security.confirmNew') }));
  const confirm = el('input', { type: 'password', autocomplete: 'new-password' });
  m.append(confirm);
  const err = el('div', { className: 'fsub err', style: 'min-height:16px' });
  m.append(err);
  const actions = el('div', { className: 'modal-actions' });
  const cancel = el('button', { textContent: t('btn.cancel') }); cancel.onclick = close;
  const ok = el('button', { className: 'primary', textContent: t('btn.save') });
  ok.onclick = async () => {
    err.textContent = '';
    if (next.value !== confirm.value) { err.textContent = t('security.err.mismatch'); return; }
    ok.disabled = true;
    try { await api.post('/api/auth/password', { current: cur.value, next: next.value }); close(); toast(t('security.pwChanged')); }
    catch (e) { ok.disabled = false; err.textContent = authErrMsg(e.message); }
  };
  actions.append(cancel, ok);
  m.append(actions);
  cur.focus();
}

// Edit a feed: custom name and/or URL.
function editFeedFlow(f) {
  const isScrape = f.kind === 'scrape';
  const bg = el('div', { className: 'modal-bg' });
  const m = el('div', { className: 'modal' });
  m.append(el('h3', { textContent: t('edit.title') }));

  m.append(el('label', { className: 'flbl', textContent: t('edit.name') }));
  const nameInput = el('input', { type: 'text', value: decodeEntities(f.title) });
  m.append(nameInput);

  m.append(el('label', { className: 'flbl', textContent: isScrape ? t('edit.sourceUrl') : t('edit.feedUrl') }));
  const urlInput = el('input', { type: 'text', value: isScrape ? (f.source_url || '') : f.feed_url });
  m.append(urlInput);
  m.append(el('p', {
    className: 'modal-warn',
    textContent: isScrape ? t('edit.rescrapeNote') : t('edit.refetchNote'),
  }));

  // Scrape mode (newsletter/scraped feeds only).
  let modeSelect = null;
  if (isScrape) {
    m.append(el('label', { className: 'flbl', textContent: t('edit.howToRead') }));
    modeSelect = el('select', { className: 'mode-select' });
    [['auto', t('edit.modeAuto')], ['page', t('edit.modePage')], ['links', t('edit.modeLinks')]]
      .forEach(([v, lbl]) => modeSelect.append(el('option', { value: v, textContent: lbl })));
    modeSelect.value = f.scrape_mode || 'auto';
    m.append(modeSelect);
    m.append(el('p', { className: 'modal-warn', textContent: t('edit.modeHint') }));
  }

  // Cloudflare challenge solver toggle (RSS feeds only).
  let solverCheck = null;
  if (!isScrape) {
    const row = el('label', { className: 'check-row' });
    solverCheck = el('input', { type: 'checkbox' });
    solverCheck.checked = !!f.use_solver;
    row.append(solverCheck, el('span', { textContent: t('edit.solver') }));
    m.append(row);
    m.append(el('p', {
      className: 'modal-warn',
      textContent: state.settings.solver_configured ? t('edit.solverOn') : t('edit.solverOff'),
    }));
  }

  const actions = el('div', { className: 'modal-actions' });
  const cancel = el('button', { textContent: t('btn.cancel') });
  cancel.onclick = () => bg.remove();
  const save = el('button', { className: 'primary', textContent: t('btn.save') });
  save.onclick = async () => {
    const title = nameInput.value.trim() || f.title;
    const url = urlInput.value.trim();
    const payload = { title, feed_url: url || undefined };
    if (solverCheck) payload.use_solver = solverCheck.checked;
    if (modeSelect) payload.scrape_mode = modeSelect.value;
    save.disabled = true; cancel.disabled = true; save.textContent = t('btn.saving');
    try {
      const r = await api.patch('/api/feeds/' + f.id, payload);
      bg.remove();
      if (r.refresh && !r.refresh.ok) toast(t('toast.savedUrlFailed', r.refresh.error));
      else toast(t('toast.saved'));
      await afterChange();
    } catch (e) {
      save.disabled = false; cancel.disabled = false; save.textContent = t('btn.save');
      toast(t('toast.failed', e.message));
    }
  };
  actions.append(cancel, save);
  m.append(actions);
  bg.append(m);
  bg.onclick = (e) => { if (e.target === bg) bg.remove(); };
  document.body.append(bg);
  nameInput.focus();
}

// Confirmation dialog that lists every unreachable feed before deleting them.
function removeUnreachableFlow(unreachable) {
  const bg = el('div', { className: 'modal-bg' });
  const m = el('div', { className: 'modal' });
  const n = unreachable.length;
  m.append(el('h3', { textContent: t('remove.confirmTitle', n) }));
  m.append(el('p', {
    className: 'modal-warn',
    textContent: t('remove.warn'),
  }));

  const list = el('div', { className: 'remove-list' });
  for (const f of unreachable) {
    const row = el('div', { className: 'remove-item' });
    row.append(el('span', { className: 'sdot unreachable', textContent: STATUS_GLYPH.unreachable }));
    const meta = el('div', { style: 'min-width:0' });
    meta.append(el('div', { className: 'ri-name', textContent: decodeEntities(f.title) }));
    meta.append(el('div', { className: 'ri-err', textContent: '⚠ ' + String(f.last_error || '').replace(/\s+/g, ' ').slice(0, 140) }));
    row.append(meta);
    list.append(row);
  }
  m.append(list);

  const actions = el('div', { className: 'modal-actions' });
  const cancel = el('button', { textContent: t('btn.cancel') });
  cancel.onclick = () => bg.remove();
  const ok = el('button', { className: 'danger', textContent: t('remove.btn', n) });
  ok.onclick = async () => {
    ok.disabled = true; cancel.disabled = true; ok.textContent = t('remove.removing');
    try {
      const r = await api.post('/api/feeds/bulk-delete', { ids: unreachable.map((f) => f.id) });
      bg.remove();
      toast(t('toast.removed', r.removed));
      await afterChange();
    } catch (e) {
      ok.disabled = false; cancel.disabled = false; ok.textContent = t('remove.btn', n);
      toast(t('toast.failed', e.message));
    }
  };
  actions.append(cancel, ok);
  m.append(actions);
  bg.append(m);
  bg.onclick = (e) => { if (e.target === bg) bg.remove(); };
  document.body.append(bg);
}

// Fetch fresh data then repaint (used after any change).
async function renderSettings() {
  if (!settingsEl) return;
  settingsData = await api.get('/api/feeds/detail');
  paintSettings();
}

// Repaint from cached data (used for instant filter toggles).
function paintSettings() {
  if (!settingsEl || !settingsData) return;
  const data = settingsData;
  const m = settingsEl.querySelector('.modal');
  m.innerHTML = '';

  const head = el('div', { className: 'settings-head' });
  const closeBtn = el('button', { className: 'icon-btn', textContent: '✕', title: t('settings.close') });
  closeBtn.onclick = closeSettings;
  head.append(el('h3', { textContent: t('settings.title') }), closeBtn);
  m.append(head);

  const body = el('div', { className: 'settings-body' });
  m.append(body);

  // --- General ---
  const genSec = el('div', { className: 'settings-section' });
  genSec.append(el('h4', { textContent: t('settings.general') }));

  // Language selector.
  const langRow = el('div', { className: 'settings-row' });
  langRow.append(el('span', { textContent: t('settings.language') }));
  const langSelect = el('select', { className: 'lang-select' });
  for (const l of LANGS) langSelect.append(el('option', { value: l.code, textContent: l.label }));
  langSelect.value = lang;
  langSelect.onchange = () => setLanguage(langSelect.value);
  langRow.append(langSelect);
  genSec.append(langRow);

  const row1 = el('div', { className: 'settings-row' });
  row1.append(el('span', { textContent: t('settings.inactiveAfter') }));
  const months = el('input', { type: 'number', min: '1', max: '120', value: String(state.settings.inactive_months ?? 9), className: 'num-input' });
  row1.append(months, el('span', { textContent: t('settings.monthsNoArticle') }));
  genSec.append(row1);

  const row2 = el('div', { className: 'settings-row' });
  const autoChk = el('input', { type: 'checkbox' });
  autoChk.checked = Number(state.settings.autorefresh_seconds) > 0;
  const autoLbl = el('label', { className: 'check-row', style: 'margin-top:0' });
  autoLbl.append(autoChk, el('span', { textContent: t('settings.autorefreshEvery') }));
  const secs = el('input', { type: 'number', min: '10', max: '3600', value: String(Number(state.settings.autorefresh_seconds) || 60), className: 'num-input' });
  row2.append(autoLbl, secs, el('span', { textContent: t('settings.seconds') }));
  genSec.append(row2);

  const row3 = el('div', { className: 'settings-row' });
  const delChk = el('input', { type: 'checkbox' });
  delChk.checked = Number(state.settings.retention_days) > 0;
  const delLbl = el('label', { className: 'check-row', style: 'margin-top:0' });
  delLbl.append(delChk, el('span', { textContent: t('settings.autodelete') }));
  const days = el('input', { type: 'number', min: '1', max: '3650', value: String(Number(state.settings.retention_days) || 30), className: 'num-input' });
  row3.append(delLbl, days, el('span', { textContent: t('settings.days') }));
  genSec.append(row3);
  genSec.append(el('p', { className: 'modal-warn', textContent: t('settings.retentionNote') }));

  const saveBtn = el('button', { className: 'settings-save', textContent: t('btn.save') });
  saveBtn.onclick = async () => {
    const inactive_months = Math.min(120, Math.max(1, Number(months.value) || 9));
    const autorefresh_seconds = autoChk.checked ? Math.min(3600, Math.max(10, Number(secs.value) || 60)) : 0;
    const retention_days = delChk.checked ? Math.min(3650, Math.max(1, Number(days.value) || 30)) : 0;
    saveBtn.disabled = true;
    state.settings = await api.put('/api/settings', { inactive_months, autorefresh_seconds, retention_days });
    startAutoRefresh();
    toast(t('toast.settingsSaved'));
    await renderSettings();
  };
  genSec.append(el('div', { className: 'settings-row', style: 'margin-top:6px' }, saveBtn));
  body.append(genSec);

  // --- Security (account, 2FA) ---
  renderSecuritySection(body);

  // --- Add feed / newsletter ---
  const addSec = el('div', { className: 'settings-section' });
  addSec.append(el('h4', { textContent: t('settings.addFeed') }));
  const addRow = el('div', { className: 'settings-add' });
  const addInput = el('input', { type: 'text', placeholder: t('settings.addPh') });
  const addBtn = el('button', { textContent: t('add.btn') });
  const doAdd = async () => { const u = addInput.value.trim(); if (!u) return; await runAdd(u, addBtn); addInput.value = ''; };
  addBtn.onclick = doAdd;
  addInput.onkeydown = (e) => { if (e.key === 'Enter') doAdd(); };
  addRow.append(addInput, addBtn);
  addSec.append(addRow);
  body.append(addSec);

  // --- Categories ---
  const catSec = el('div', { className: 'settings-section' });
  catSec.append(el('h4', { textContent: t('settings.categories') }));
  const catAdd = el('div', { className: 'settings-add' });
  const catInput = el('input', { type: 'text', placeholder: t('settings.newCatPh') });
  const catBtn = el('button', { textContent: t('btn.create') });
  const doCat = async () => { const n = catInput.value.trim(); if (!n) return; await api.post('/api/categories', { name: n }); catInput.value = ''; await afterChange(); };
  catBtn.onclick = doCat;
  catInput.onkeydown = (e) => { if (e.key === 'Enter') doCat(); };
  catAdd.append(catInput, catBtn);
  catSec.append(catAdd);

  // Category chips double as FILTERS for the feed list below: click to show
  // only that category's feeds, click again (or "All") to clear. Each real
  // category keeps a ✕ that deletes it after confirmation.
  const catList = el('div', { className: 'cat-list' });
  if (!data.categories.length) catList.append(el('span', { style: 'color:var(--muted);font-size:13px', textContent: t('settings.noCats') }));
  else {
    const setCat = (v) => { settingsCatFilter = settingsCatFilter === v ? 'all' : v; paintSettings(); };
    const catChip = (label, value, count, delCat) => {
      const chip = el('div', {
        className: 'cat-chip' + (settingsCatFilter === value ? ' sel' : ''),
        role: 'button', tabIndex: 0, title: label,
      });
      chip.append(el('span', { textContent: label }), el('span', { className: 'n', textContent: `(${count})` }));
      chip.onclick = () => setCat(value);
      chip.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCat(value); } };
      if (delCat) {
        const del = el('button', { textContent: '✕', title: t('settings.removeCat') });
        del.onclick = async (e) => {
          e.stopPropagation(); // deleting must not toggle the filter
          if (confirm(t('confirm.removeCat', delCat.name, delCat.feeds))) {
            if (settingsCatFilter === value) settingsCatFilter = 'all';
            await api.del('/api/categories/' + delCat.id);
            await afterChange();
          }
        };
        chip.append(del);
      }
      return chip;
    };
    catList.append(catChip(t('filter.all'), 'all', data.feeds.length));
    for (const c of data.categories) catList.append(catChip(c.name, c.name, c.feeds, c));
    const unfiled = data.feeds.filter((f) => !f.category).length;
    if (unfiled) catList.append(catChip(t('nav.uncategorized'), CAT_UNFILED, unfiled));
  }
  catSec.append(catList);
  body.append(catSec);

  // --- Feeds & newsletters ---
  const feedSec = el('div', { className: 'settings-section' });
  const counts = { active: 0, inactive: 0, unreachable: 0 };
  data.feeds.forEach((f) => counts[feedStatus(f).key]++);
  const total = data.feeds.length;
  // Section header with a collapse-all / expand-all toggle (like the sidebar's).
  const feedHead = el('div', { className: 'settings-h4row' });
  feedHead.append(el('h4', { textContent: t('settings.feeds') }));
  const collAllBtn = el('button', { className: 'collapse-toggle', textContent: '⊟', title: t('btn.collapseAll') });
  feedHead.append(collAllBtn);
  feedSec.append(feedHead);
  let visibleGroupKeys = [];
  collAllBtn.onclick = () => {
    const allCollapsed = visibleGroupKeys.length > 0 && visibleGroupKeys.every((k) => settingsCollapsed[k]);
    for (const k of visibleGroupKeys) settingsCollapsed[k] = !allCollapsed;
    localStorage.setItem('settingsCollapsed', JSON.stringify(settingsCollapsed));
    renderRows();
  };

  // Clickable filter chips. Clicking a status shows only those feeds; clicking
  // it again (or "All") clears the filter.
  const sel = settingsStatusFilter;
  const setFilter = (k) => { settingsStatusFilter = k; paintSettings(); };
  const toggle = (k) => { settingsStatusFilter = sel === k ? 'all' : k; paintSettings(); };
  const legend = el('div', { className: 'status-legend' });
  legend.append(
    filterChip('all', t('filter.all'), total, sel === 'all', () => setFilter('all')),
    filterChip('active', t('status.active'), counts.active, sel === 'active', () => toggle('active')),
    filterChip('inactive', t('status.inactive'), counts.inactive, sel === 'inactive', () => toggle('inactive')),
    filterChip('unreachable', t('status.unreachable'), counts.unreachable, sel === 'unreachable', () => toggle('unreachable')),
  );
  if (counts.unreachable > 0) {
    const ur = data.feeds.filter((f) => feedStatus(f).key === 'unreachable');
    const rmBtn = el('button', { className: 'remove-unreachable-btn', textContent: `${STATUS_GLYPH.unreachable} ${t('removeUnreachable.btn', counts.unreachable)}` });
    rmBtn.onclick = () => removeUnreachableFlow(ur);
    legend.append(rmBtn);
  }
  // Live search box next to the filters — filters the list as you type, without
  // a full repaint (so focus/caret are preserved).
  const search = el('input', {
    type: 'search', className: 'feed-search', placeholder: t('settings.searchPh'), value: settingsSearch,
  });
  legend.append(search);
  feedSec.append(legend);

  const table = el('div', { className: 'feed-table' });
  feedSec.append(table);
  search.oninput = () => { settingsSearch = search.value; renderRows(); };

  // (Re)build just the rows from the category chip + status filter + search text.
  function renderRows() {
    table.innerHTML = '';
    const q = settingsSearch.trim().toLowerCase();
    const shown = data.feeds.filter((f) => {
      if (settingsCatFilter !== 'all') {
        const want = settingsCatFilter === CAT_UNFILED ? null : settingsCatFilter;
        if ((f.category || null) !== want) return false;
      }
      if (sel !== 'all' && feedStatus(f).key !== sel) return false;
      if (!q) return true;
      return [f.title, f.feed_url, f.site_url, f.source_url, f.category]
        .some((v) => v && String(v).toLowerCase().includes(q));
    });
    if (!shown.length) {
      visibleGroupKeys = [];
      collAllBtn.hidden = true;
      table.append(el('div', { className: 'feed-mgr', textContent: total ? (q ? t('settings.noMatch') : t('settings.noneWithStatus')) : t('settings.noSubs') }));
      return;
    }
    // Group under collapsible category headers (feeds are already ordered by
    // category then name). A search forces every group open so matches show.
    const groups = [];
    const byKey = new Map();
    for (const f of shown) {
      const key = f.category ? 'c:' + f.category : 'uncat';
      let g = byKey.get(key);
      if (!g) { g = { key, name: f.category || t('nav.uncategorized'), feeds: [] }; byKey.set(key, g); groups.push(g); }
      g.feeds.push(f);
    }
    // Categories alphabetically (uncategorized last), feeds alphabetically within.
    const coll = new Intl.Collator(curLocale(), { sensitivity: 'base' });
    groups.sort((a, b) => (a.key === 'uncat') - (b.key === 'uncat') || coll.compare(a.name, b.name));
    for (const g of groups) g.feeds.sort((a, b) => coll.compare(decodeEntities(a.title), decodeEntities(b.title)));
    // Keep the collapse-all toggle in sync with what's on screen. A search
    // forces groups open, so the toggle is moot (hidden) while searching.
    visibleGroupKeys = groups.map((g) => g.key);
    collAllBtn.hidden = !!q;
    const allCollapsed = !q && visibleGroupKeys.every((k) => settingsCollapsed[k]);
    collAllBtn.textContent = allCollapsed ? '⊞' : '⊟';
    collAllBtn.title = allCollapsed ? t('btn.expandAll') : t('btn.collapseAll');
    for (const g of groups) {
      const collapsed = !q && !!settingsCollapsed[g.key];
      const head = el('div', { className: 'feed-cat-head' + (collapsed ? ' collapsed' : '') });
      head.append(
        el('span', { className: 'twist', textContent: '▾' }),
        el('span', { className: 'feed-cat-name', textContent: g.name }),
        el('span', { className: 'feed-cat-count', textContent: String(g.feeds.length) }),
      );
      head.onclick = () => {
        settingsCollapsed[g.key] = !settingsCollapsed[g.key];
        localStorage.setItem('settingsCollapsed', JSON.stringify(settingsCollapsed));
        renderRows();
      };
      table.append(head);
      if (!collapsed) for (const f of g.feeds) table.append(buildFeedRow(f, data));
    }
  }
  renderRows();
  body.append(feedSec);
  return;
}

// Build one feed-management row for the settings list.
function buildFeedRow(f, data) {
  {
    const st = feedStatus(f);
    const row = el('div', { className: 'feed-mgr' });
    row.append(el('span', { className: 'sdot ' + st.key, textContent: STATUS_GLYPH[st.key], title: st.label + (f.last_error ? ': ' + f.last_error : '') }));

    const meta = el('div', { className: 'meta' });
    const name = el('div', { className: 'fname' });
    name.append(el('span', { textContent: decodeEntities(f.title) }));
    // The kind badge links out: RSS -> the feed URL, Newsletter -> its source page.
    const isScrape = f.kind === 'scrape';
    const kindHref = isScrape ? (f.source_url || f.site_url) : f.feed_url;
    const kindLabel = isScrape ? t('kind.newsletter') : t('kind.rss');
    name.append(el('a', {
      className: 'kind',
      textContent: kindLabel,
      href: kindHref || '#',
      target: '_blank',
      rel: 'noopener noreferrer',
      title: isScrape ? t('kind.openSource', kindHref || '') : t('kind.openRss', f.feed_url),
    }));
    name.append(el('span', { className: 'status-text ' + st.key, textContent: `[${st.label}]` }));
    // The name line can be truncated to save space — expose the full text on hover.
    name.title = `${decodeEntities(f.title)} · ${kindLabel} · [${st.label}]`;
    meta.append(name);
    const sub = el('div', { className: 'fsub' + (st.key === 'unreachable' ? ' err' : '') });
    sub.textContent = st.key === 'unreachable'
      ? '⚠ ' + f.last_error
      : t('feed.items', f.total, f.unread, f.newest ? fmtDate(f.newest) : null);
    if (st.key !== 'unreachable' && f.site_url) sub.title = f.site_url;
    meta.append(sub);
    row.append(meta);

    const sel = el('select', { title: t('settings.category') });
    sel.append(el('option', { value: '', textContent: t('nav.uncategorized') }));
    for (const c of data.categories) sel.append(el('option', { value: c.name, textContent: c.name }));
    sel.value = f.category || '';
    sel.onchange = async () => { await api.patch('/api/feeds/' + f.id, { category: sel.value || null }); await afterChange(); };
    row.append(sel);

    const acts = el('div', { className: 'feed-actions' });
    const editBtn = el('button', { className: 'fbtn', textContent: t('btn.edit') });
    editBtn.onclick = () => editFeedFlow(f);
    const unsub = el('button', { className: 'fbtn unsub', textContent: t('btn.unsubscribe') });
    unsub.onclick = async () => { if (confirm(t('confirm.unsub', decodeEntities(f.title)))) { await api.del('/api/feeds/' + f.id); await afterChange(); } };
    acts.append(editBtn, unsub);
    row.append(acts);
    return row;
  }
}

// ---------- Theme (Material: auto / light / dark) ----------
const THEMES = ['auto', 'light', 'dark'];
const THEME_ICON = { auto: '🌓', light: '☀️', dark: '🌙' };
let theme = localStorage.getItem('theme') || 'auto';
function applyTheme(th) {
  if (th === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', th);
  const btn = $('#theme-btn');
  btn.textContent = THEME_ICON[th];
  btn.title = t('theme.btnTitle', t('theme.' + th));
}
applyTheme(theme);
$('#theme-btn').onclick = () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  localStorage.setItem('theme', theme);
  applyTheme(theme);
  toast(t('theme.toast', t('theme.' + theme)));
};

// ---------- Collapsible sidebar ----------
let sidebarHidden = localStorage.getItem('sidebarHidden') === '1';
function applySidebar() {
  const app = $('#app');
  app.classList.toggle('sidebar-hidden', sidebarHidden);
  if (!sidebarHidden) app.classList.remove('peek');
  const b = $('#sidebar-toggle');
  b.textContent = sidebarHidden ? '☰' : '⮜';
  b.title = sidebarHidden ? t('btn.showSidebar') : t('btn.hideSidebar');
}
$('#sidebar-toggle').onclick = () => {
  sidebarHidden = !sidebarHidden;
  localStorage.setItem('sidebarHidden', sidebarHidden ? '1' : '0');
  applySidebar();
};
// While hidden: hovering the left edge slides the sidebar in; leaving it slides back.
$('#edge-hover').addEventListener('mouseenter', () => { if (sidebarHidden) $('#app').classList.add('peek'); });
$('#sidebar').addEventListener('mouseleave', () => { if (sidebarHidden) $('#app').classList.remove('peek'); });
applySidebar();

// ---------- Wire up ----------
$('#collapse-toggle').onclick = toggleCollapseAll;
$('#menu-btn').onclick = () => openSettings();
$('#health-btn').onclick = (e) => openSettings(e.currentTarget.dataset.jump || 'all');
$('#add-btn').onclick = addFeed;
$('#add-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') addFeed(); });
$('#refresh-btn').onclick = refreshAll;
const markMenu = $('#mark-read-menu');
$('#mark-all-btn').onclick = (e) => { e.stopPropagation(); markMenu.hidden = !markMenu.hidden; };
markMenu.querySelectorAll('button').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); markMenu.hidden = true; markAllRead(b.dataset.age); }; });
document.addEventListener('click', () => { markMenu.hidden = true; });
$('#filter-select').onchange = (e) => { state.filter = e.target.value; loadItems(); };
$('#reload-btn').onclick = reloadView;
// Live full-text search: debounced as-you-type; clearing restores the last view.
(() => {
  const box = $('#search-box');
  if (!box) return;
  let timer;
  box.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const q = box.value.trim();
      if (q.length >= 2) { state.selection = { type: 'search', q }; highlightSelection(); loadItems(); }
      else if (!q && state.selection.type === 'search') select(lastBrowseSelection);
    }, 350);
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { box.value = ''; if (state.selection.type === 'search') select(lastBrowseSelection); box.blur(); }
  });
})();
$('#stream').addEventListener('scroll', onStreamScroll, { passive: true });
document.querySelectorAll('.nav-item').forEach((n) => n.onclick = (e) => { e.preventDefault(); select({ type: n.dataset.view }); });
$('#opml-file').onchange = (e) => { if (e.target.files[0]) importOpml(e.target.files[0]); };

// ---------- Mobile controls ----------
$('#mb-cats').onclick = openDrawer;
$('#mb-top').onclick = () => { $('#stream').scrollTop = 0; };
$('#av-back').onclick = closeMobileArticle;
$('#drawer-backdrop').onclick = closeDrawer;
(() => {
  let sx = 0, sy = 0;
  const av = $('#article-view');
  av.addEventListener('touchstart', (e) => { const t = e.changedTouches[0]; sx = t.clientX; sy = t.clientY; }, { passive: true });
  av.addEventListener('touchend', (e) => {
    const t = e.changedTouches[0]; const dx = t.clientX - sx; const dy = t.clientY - sy;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) mobileNav(dx < 0 ? 1 : -1); // left=next, right=prev
  }, { passive: true });
})();
// Switching between desktop/mobile layouts re-renders and clears overlays.
mq.addEventListener('change', () => { closeMobileArticle(); closeDrawer(); renderStream(); });

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && settingsEl) { closeSettings(); return; }
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
  const idx = state.items.findIndex((x) => x.id === state.current?.id);
  if (e.key === 'j') {
    e.preventDefault();
    const n = state.items[idx + 1];
    if (n) { const cur = state.current; if (cur && !cur.is_read) markRead(cur, true); setActive(n.id, { scroll: true }); }
    else if (state.items.length) {
      // On the last loaded article: mark it read, then pull the next page if
      // one exists and advance into it; otherwise show the end hint.
      if (state.current && !state.current.is_read) markRead(state.current, true);
      if (streamHasMore) {
        loadMore().then(() => {
          const i2 = state.items.findIndex((x) => x.id === state.current?.id);
          const nn = state.items[i2 + 1];
          if (nn) setActive(nn.id, { scroll: true });
          else edgeHint(t('edge.atEnd'), 'at-end');
        });
      } else edgeHint(t('edge.atEnd'), 'at-end');
    }
  }
  if (e.key === 'k') {
    e.preventDefault();
    const p = state.items[idx - 1];
    if (p) setActive(p.id, { scroll: true });
    else if (state.items.length) edgeHint(t('edge.atStart'), 'at-start');
  }
  if (e.key === 'm' && state.current) markRead(state.current, !state.current.is_read);
  if (e.key === 's' && state.current) {
    const card = $('#stream').querySelector(`.article[data-id="${state.current.id}"]`);
    if (card) toggleSaved(state.current, card.querySelector('.save'));
  }
});

// Pause auto-refresh while the tab is hidden (battery/data); catch up on return.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (autoTimer) { clearInterval(autoTimer); autoTimer = null; } }
  else { startAutoRefresh(); refreshStream().catch(() => {}); }
});

// PWA: register the service worker (app shell caching + installability).
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

applyStaticI18n(); // translate static markup before first interaction
api.get('/api/settings')
  .then((s) => { state.settings = { inactive_months: 9, autorefresh_seconds: 60, retention_days: 30, ...s }; startAutoRefresh(); })
  .catch(() => {});
loadState();
select({ type: 'all' });
