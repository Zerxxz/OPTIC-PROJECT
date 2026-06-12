/**
 * Page entry: decisions — the live decision log viewer.
 * Wires up filter controls and renders the decision feed.
 */
import '@/assets/optic.css';
import { mountChrome } from '@/modules/chrome';
import {
  fetchLiveDecisions,
  MOCK_DECISIONS,
  applyFilters,
  renderDecisions,
  DEFAULT_FILTERS,
  ALL_ACTIONS,
  type Decision,
  type DecisionFilters,
} from '@/modules/decisions';
import type { ActionKind } from '@/types/decisions';

mountChrome();

const container = document.getElementById('decision-list') as HTMLElement | null;
const agentSelect = document.getElementById('filter-agent') as HTMLSelectElement | null;
const actionSelect = document.getElementById('filter-action') as HTMLSelectElement | null;
const sourceBadge = document.getElementById('data-source') as HTMLElement | null;

if (!container || !agentSelect || !actionSelect) {
  console.warn('[OPTIC] decisions page missing required elements');
} else {
  const filters: DecisionFilters = { ...DEFAULT_FILTERS };

  function refresh(): void {
    const filtered = applyFilters(allDecisions, filters);
    renderDecisions(container!, filtered);
  }

  let allDecisions: Decision[] = MOCK_DECISIONS;

  // Populate filter options dynamically (single source of truth).
  ALL_ACTIONS.forEach((a: ActionKind) => {
    const opt = document.createElement('option');
    opt.value = a;
    opt.textContent = a;
    actionSelect!.appendChild(opt);
  });

  agentSelect.addEventListener('change', () => {
    filters.agent = agentSelect!.value as DecisionFilters['agent'];
    refresh();
  });
  actionSelect.addEventListener('change', () => {
    filters.action = actionSelect!.value as DecisionFilters['action'];
    refresh();
  });

  // Try live fetch; fall back to mock silently.
  void (async () => {
    const live = await fetchLiveDecisions();
    if (live && live.length > 0) {
      allDecisions = live;
      if (sourceBadge) {
        sourceBadge.textContent = 'live · Walrus';
        sourceBadge.classList.add('live');
      }
    } else if (sourceBadge) {
      sourceBadge.textContent = 'mock · demo';
    }
    refresh();
  })();
}
