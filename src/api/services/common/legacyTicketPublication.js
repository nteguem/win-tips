'use strict';

const text = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const namesFor = value => {
  if (typeof value === 'string') return { fr: text(value) || 'Coupon', en: text(value) || 'Coupon' };
  const fr = text(value?.fr), en = text(value?.en);
  return { fr: fr || en || 'Coupon', en: en || fr || 'Coupon' };
};
const canonical = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]/g, '');
const number = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;

function buildLegacyTicketPublication(ticket, category) {
  const names = namesFor(category.name), isVip = category.isVip === true;
  const isLive = [names.fr, names.en].some(name => ['live', 'endirect'].includes(canonical(name)));
  const date = ticket.date == null || ticket.date === '' ? null : new Date(ticket.date);
  const validDate = date && Number.isFinite(date.getTime());
  const options = { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' };
  const edition = validDate ? { iso: date.toISOString().slice(0, 10),
    fr: new Intl.DateTimeFormat('fr-FR', options).format(date), en: new Intl.DateTimeFormat('en-GB', options).format(date) } : null;
  const icon = isLive ? '🔴' : isVip ? '💎' : '🆓';
  return {
    headings: { fr: `${icon} ${names.fr} · ${isVip ? 'VIP' : 'Gratuit'}`, en: `${icon} ${names.en} · ${isVip ? 'VIP' : 'Free'}` },
    contents: {
      fr: `${edition ? `Édition du ${edition.fr} : ` : ''}votre coupon ${isVip ? 'VIP' : 'gratuit'} est disponible. Découvrez les rencontres et les sélections.`,
      en: `${edition ? `Edition for ${edition.en}: ` : ''}your ${isVip ? 'VIP' : 'free'} coupon is available. Explore the matches and selections.`,
    },
    data: {
      notificationId: `ticket-published:${ticket._id}`,
      type: isLive ? 'live' : 'ticket', ticket_id: String(ticket._id),
      category_id: String(category._id || ticket.category), category_name: names.fr,
      category_name_fr: names.fr, category_name_en: names.en, category_is_vip: isVip, vip: isVip,
      // These are the existing legacy actions. Native editorial items use
      // view_editorial/view_editorial_feed through their separate worker.
      action: isLive ? 'view_live' : 'view_ticket',
      ...(edition ? { edition_date: edition.iso } : {}),
    },
    options: { android_accent_color: isLive ? 'FF0000' : isVip ? 'FFD700' : 'FF6B35',
      small_icon: 'ic_stat_onesignal_default', large_icon: 'ic_launcher' },
  };
}

function publicationOutcome(result) {
  const stats = result?._stats;
  const counts = {
    accepted: stats ? number(stats.fcm) + number(stats.onesignal) : number(result?.recipients),
    failed: number(stats?.failed), skipped: number(stats?.skipped), unreachable: number(stats?.unreachable),
  };
  if (result?.dryRun === true || stats?.dryRun === true) return { status: 'not_needed', reason: 'notifications_disabled', counts: { ...counts, accepted: 0 } };
  if (stats && counts.failed) return { status: 'uncertain', reason: 'partial_or_failed_transport', counts };
  if (stats && !counts.accepted) return { status: 'not_needed', reason: 'no_accepted_recipients', counts };
  if (result?.id || counts.accepted) return { status: 'sent', counts };
  return { status: 'uncertain', reason: 'transport_not_confirmed', counts };
}

// The publication ledger is system-owned. An old admin form echoing a ticket
// must not overwrite its marker or reset a sending/sent publication to pending.
function stripPublicationMarker(update) {
  const protectedPath = key => typeof key === 'string' && (key === 'publicationNotification' || key.startsWith('publicationNotification.'));
  for (const [key, value] of Object.entries(update)) {
    if (protectedPath(key)) delete update[key];
    else if (key.startsWith('$') && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [path, target] of Object.entries(value)) {
        if (protectedPath(path) || (key === '$rename' && protectedPath(target))) delete value[path];
      }
    }
  }
  return update;
}

module.exports = { buildLegacyTicketPublication, publicationOutcome, stripPublicationMarker };
