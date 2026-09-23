/**
 * Ein `MutationObserver` ab dem ersten Skript — als Init-Skript für
 * Playwright, geteilt von der Browserreihe (`diagnose.ts`) und dem Messskript
 * (`scripts/hydration-messung.ts`).
 *
 * **Warum an `document` und nicht an `document.documentElement`:** Das
 * Init-Skript läuft, bevor der Parser irgendetwas erzeugt hat; das
 * Wurzelelement gibt es da noch nicht. Ein Beobachter daran wurde in Wave 9.1
 * nie eingehängt und meldete „0 Entfernungen" — was wie ein Befund aussah und
 * keiner war.
 *
 * **Keine Inhalte.** Festgehalten werden Tag, Kennung, bis zu drei Klassen
 * und einige unkritische Attribute (`type`, `form`, `role`, `data-slot`,
 * `data-state`, `aria-hidden`, `hidden`) — nie Text, nie Werte von
 * Eingabefeldern. Die Befunde enthalten damit keine Namen oder Adressen aus
 * dem Testbestand und dürfen als Artefakt liegen bleiben.
 *
 * Er misst nur, er greift nicht ein: Er verändert das DOM nicht und hält
 * keine Knoten fest. Dass er die Hydration um Mikrosekunden verschiebt, ist
 * der Preis jeder Beobachtung — Wave 9.1 hat mit demselben Beobachter die
 * Ursache in §13 gefunden, der Fehler blieb dabei sichtbar.
 */
export const MUTATIONS_BEOBACHTER = `(() => {
  if (window.__hydrationsMutationen) return;
  const t0 = performance.now();
  const log = [];
  window.__hydrationsMutationen = log;
  const ATTRS = ['type', 'form', 'role', 'data-slot', 'data-state', 'aria-hidden', 'hidden'];
  const beschreibe = (n) => {
    if (!n || n.nodeType !== 1) return n && n.nodeType === 3 ? '#text' : n && n.nodeType === 8 ? '#kommentar' : '?';
    const e = n;
    const cls = (e.getAttribute('class') || '').split(/\\s+/).filter(Boolean).slice(0, 3).join('.');
    const attrs = ATTRS.filter((a) => e.hasAttribute(a)).map((a) => a + '=' + String(e.getAttribute(a)).slice(0, 40));
    return e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (cls ? '.' + cls : '') + (attrs.length ? '[' + attrs.join(',') + ']' : '');
  };
  const pfad = (n) => {
    const teile = [];
    let e = n;
    for (let i = 0; e && e.nodeType === 1 && i < 6; i++, e = e.parentElement) teile.unshift(beschreibe(e));
    return teile.join(' > ');
  };
  const mo = new MutationObserver((liste) => {
    const zeit = Math.round(performance.now() - t0);
    for (const m of liste) {
      if (m.type !== 'childList' || log.length > 5000) continue;
      for (const n of m.removedNodes) log.push({ zeit, art: 'entfernt', knoten: beschreibe(n), unter: pfad(m.target) });
      for (const n of m.addedNodes) log.push({ zeit, art: 'eingefuegt', knoten: beschreibe(n), unter: pfad(m.target) });
    }
  });
  mo.observe(document, { childList: true, subtree: true });
  const fehler = (ereignis) => {
    const text = String((ereignis && (ereignis.message || (ereignis.reason && ereignis.reason.message))) || '');
    if (/418|hydrat/i.test(text)) log.push({ zeit: Math.round(performance.now() - t0), art: 'HYDRATIONSFEHLER' });
  };
  window.addEventListener('error', fehler);
  window.addEventListener('load', () => log.push({ zeit: Math.round(performance.now() - t0), art: 'load' }));
})();`;
