/**
 * Config Wizard — Main Application Logic
 *
 * Handles: step navigation, map interaction, form state, config export.
 */

// ==========================================================================
// Constants
// ==========================================================================
const configuration = new ConfigurationState();
let selectedPresetId = null;
let presetRequest = 0;
let presets = [];
let baselineConfig = null;
let advancedEditor = null;
let sourceMigrations = [];
let sourceWarnings = [];
let reviewFingerprint = null;
let reviewRequest = 0;

const STEPS = [
  { id: 'start', label: 'Start' },
  { id: 'region',     label: 'Region' },
  { id: 'surveys',    label: 'Surveys' },
  { id: 'modes',      label: 'Modes' },
  { id: 'transit',    label: 'Transit' },
  { id: 'demand',     label: 'Demand' },
  { id: 'time',       label: 'Time' },
  { id: 'simulation', label: 'Simulation' },
  { id: 'advanced', label: 'Advanced' },
  { id: 'review', label: 'Review' },
];

const DURATION_ACTIVITIES = ['Work', 'School', 'Shopping', 'Escort', 'Dining', 'Social', 'Other'];

// ==========================================================================
// State
// ==========================================================================
let currentStep = 0;
let selectedCounties = {};   // { GEOID: { name, population, feature } }
let countyGeoJSON = null;
let map = null;
let countyLayer = null;
let zoomMessageEl = null;

// ==========================================================================
// Step Progress Bar
// ==========================================================================

function renderStepProgress() {
  const container = document.getElementById('stepProgress');
  container.innerHTML = '';

  STEPS.forEach((step, i) => {
    if (i > 0) {
      const sep = document.createElement('div');
      sep.className = 'step-progress__separator';
      if (i <= currentStep) sep.classList.add('step-progress__item--completed');
      container.appendChild(sep);
    }

    const item = document.createElement('button');
    item.type = 'button';
    item.disabled = i > currentStep;
    item.setAttribute('aria-label', `${i + 1}. ${step.label}`);
    if (i === currentStep) item.setAttribute('aria-current', 'step');
    item.className = 'step-progress__item';
    if (i === currentStep) item.classList.add('step-progress__item--active');
    if (i < currentStep)  item.classList.add('step-progress__item--completed');
    item.onclick = () => { if (i <= currentStep) goToStep(i); };

    const icon = document.createElement('span');
    icon.className = 'step-progress__icon';
    if (i < currentStep) {
      icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" width="14" height="14"><polyline points="20 6 9 17 4 12"/></svg>';
    } else {
      icon.textContent = i + 1;
    }

    const label = document.createElement('span');
    label.textContent = step.label;

    item.appendChild(icon);
    item.appendChild(label);
    container.appendChild(item);
  });
}

function goToStep(stepIndex) {
  // Validate current step before moving forward
  if (stepIndex > currentStep && !validateStep(currentStep)) return;

  currentStep = stepIndex;
  renderStepProgress();

  // Show/hide panels
  STEPS.forEach((step, i) => {
    const panel = document.getElementById(`panel-${step.id}`);
    panel.classList.toggle('panel--active', i === currentStep);
    if (i < currentStep) {
      panel.classList.add('panel--completed');
    }
  });

  // Scroll to active panel
  const activePanel = document.getElementById(`panel-${STEPS[currentStep].id}`);
  activePanel.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // Re-invalidate map size if returning to region step
  const heading = activePanel.querySelector('.panel__title');
  heading.tabIndex = -1;
  heading.focus({preventScroll: true});
  if (STEPS[currentStep].id === 'region' && map) {
    setTimeout(() => { map.invalidateSize(); fitSelectedRegion(); }, 100);
  }
  if (STEPS[currentStep].id === 'advanced') advancedEditor.render();
  if (STEPS[currentStep].id === 'review') { renderReview(); validateReview(); }
}

function validateStep(stepIndex) {
  const panel = document.getElementById(`panel-${STEPS[stepIndex].id}`);
  for (const input of panel.querySelectorAll('input[data-edited], select[data-edited]')) {
    if (!input.reportValidity()) return false;
  }
  switch (STEPS[stepIndex].id) {
    case 'start':
      return configuration.config !== null && !document.getElementById('btnNext0').disabled;
    case 'region': // Region
      if (Object.keys(selectedCounties).length === 0) {
        alert('Please select at least one county.');
        return false;
      }
      updateBadge('region', `${Object.keys(selectedCounties).length} counties`);
      return true;

    case 'surveys': // Surveys
      const nhts = document.getElementById('chkNhts').checked;
      const custom = document.getElementById('chkCustomSurvey').checked;
      const surveys = configuration.config?.data?.surveys;
      const active = Array.isArray(surveys) && surveys.some(s => s && typeof s === 'object' &&
        ((s.weight ?? 1) > 0 || Object.values(s.roles || {}).some(weight => weight > 0)));
      if (!active) {
        alert('At least one survey must be selected.');
        return false;
      }
      updateBadge('surveys', nhts && custom ? '2 surveys' : '1 survey');
      return true;

    default:
      // Mark badge as completed
      updateBadge(STEPS[stepIndex].id, 'Done');
      return true;
  }
}

function updateBadge(panelId, text) {
  const badge = document.getElementById(`badge-${panelId}`);
  if (badge) {
    badge.textContent = text;
    badge.classList.remove('hidden');
  }
}

// ==========================================================================
// Navigation Buttons
// ==========================================================================

function setupNavigation() {
  // Next buttons
  for (let i = 0; i < STEPS.length - 1; i++) {
    const btn = document.getElementById(`btnNext${i}`);
    if (btn) btn.onclick = () => goToStep(i + 1);
  }

  // Back buttons
  for (let i = 1; i < STEPS.length; i++) {
    const btn = document.getElementById(`btnBack${i}`);
    if (btn) btn.onclick = () => goToStep(i - 1);
  }
}

// ==========================================================================
// Map (Panel 1 — Region)
// ==========================================================================

async function initMap() {
  map = L.map('countyMap', {
    center: [39.8, -98.5],
    zoom: 4,
    minZoom: 3,
    maxZoom: 12,
  });

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
    className: 'basemap-muted',
  }).addTo(map);

  zoomMessageEl = document.getElementById('mapMessage');

  // Load county data
  try {
    const resp = await fetch('/api/counties');
    countyGeoJSON = await resp.json();
    if (!resp.ok) throw new Error('County data unavailable');
    addCountyLayer();
    syncSelectedRegion();
    updatePresetCountyNames();
  } catch (err) {
    console.error('Failed to load counties:', err);
    zoomMessageEl.textContent = 'Failed to load county data. Is the server running?';
  }

  // Show/hide counties based on zoom
  map.on('zoomend', updateCountyVisibility);
  updateCountyVisibility();
}

function addCountyLayer() {
  countyLayer = L.geoJSON(countyGeoJSON, {
    style: countyStyle,
    onEachFeature: (feature, layer) => {
      const props = feature.properties;
      layer.on({
        click: () => toggleCounty(props.GEOID, props.name, props.population, feature, layer),
        mouseover: (e) => {
          if (!selectedCounties[props.GEOID]) {
            e.target.setStyle({ fillOpacity: 0.3, weight: 2 });
          }
          layer.bindTooltip(
            `<strong>${props.name}</strong><br>Pop: ${formatNumber(props.population)}`,
            { sticky: true }
          ).openTooltip();
        },
        mouseout: (e) => {
          if (!selectedCounties[props.GEOID]) {
            countyLayer.resetStyle(e.target);
          }
          layer.closeTooltip();
        },
      });
    },
  });

  countyLayer.addTo(map);
}

function countyStyle(feature) {
  const geoid = feature.properties.GEOID;
  const isSelected = !!selectedCounties[geoid];
  return {
    fillColor: isSelected ? '#2563eb' : '#94a3b8',
    weight: isSelected ? 2.5 : 1,
    opacity: 1,
    color: isSelected ? '#1d4ed8' : '#cbd5e1',
    fillOpacity: isSelected ? 0.45 : 0.1,
  };
}

function updateCountyVisibility() {
  if (!countyLayer) return;
  const zoom = map.getZoom();
  const show = zoom >= 6;

  if (show) {
    if (!map.hasLayer(countyLayer)) map.addLayer(countyLayer);
    zoomMessageEl.style.display = 'none';
  } else {
    if (map.hasLayer(countyLayer)) map.removeLayer(countyLayer);
    zoomMessageEl.style.display = 'block';
  }
}

function toggleCounty(geoid, name, population, feature, layer) {
  if (selectedCounties[geoid]) {
    // Deselect
    delete selectedCounties[geoid];
    countyLayer.resetStyle(layer);
  } else {
    selectedCounties[geoid] = { name, population, feature };
    layer.setStyle({
      fillColor: '#2563eb',
      weight: 2.5,
      color: '#1d4ed8',
      fillOpacity: 0.45,
    });
  }

  updateMapStats();
  updateSelectedCountiesList();
  updateRegionSelection();
}

function getTotalPopulation() {
  return Object.values(selectedCounties).reduce((sum, c) => sum + (c.population || 0), 0);
}

function updateMapStats() {
  const count = Object.keys(selectedCounties).length;
  const pop = getTotalPopulation();
  document.getElementById('statCountyCount').textContent = count;

  const popEl = document.getElementById('statPopulation');
  popEl.textContent = formatNumber(pop);
  popEl.className = 'map-overlay__value';

}

function updateSelectedCountiesList() {
  const container = document.getElementById('selectedCountiesList');
  container.innerHTML = '';

  Object.entries(selectedCounties).forEach(([geoid, data]) => {
    const tag = document.createElement('span');
    tag.className = 'tag tag--primary';
    tag.append(document.createTextNode(`${data.name} (${formatNumber(data.population)}) `));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'tag__remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove ${data.name}`);
    remove.onclick = () => removeCounty(geoid);
    tag.appendChild(remove);
    container.appendChild(tag);
  });
}

function removeCounty(geoid) {
  delete selectedCounties[geoid];
  // Reset style on the map layer
  if (countyLayer) {
    countyLayer.eachLayer((layer) => {
      if (layer.feature.properties.GEOID === geoid) {
        countyLayer.resetStyle(layer);
      }
    });
  }
  updateMapStats();
  updateSelectedCountiesList();
  updateRegionSelection();
}

function updateRegionSelection() {
  document.getElementById('btnNext1').disabled = Object.keys(selectedCounties).length === 0;
  if (configuration.config) configuration.set(['region', 'counties'], Object.keys(selectedCounties));
}

function syncSelectedRegion() {
  const value = configuration.get(['region', 'counties']);
  const counties = Array.isArray(value) ? value : [];
  selectedCounties = {};
  for (const geoid of counties) {
    const feature = countyGeoJSON?.features.find(f => f.properties.GEOID === geoid);
    selectedCounties[geoid] = {name: feature?.properties.name || geoid,
      population: feature?.properties.population || 0, feature};
  }
  if (countyLayer) countyLayer.setStyle(countyStyle);
  updateMapStats();
  updateSelectedCountiesList();
  // Hydration must not rewrite array order or add configuration fields.
  document.getElementById('btnNext1').disabled = counties.length === 0;
}

function fitSelectedRegion() {
  if (!countyLayer || !map) return;
  const layers = [];
  countyLayer.eachLayer(layer => { if (selectedCounties[layer.feature.properties.GEOID]) layers.push(layer); });
  if (layers.length) map.fitBounds(L.featureGroup(layers).getBounds(), {padding: [20, 20], maxZoom: 9});
}

// ==========================================================================
// Panel 2 — Surveys
// ==========================================================================

function setupSurveys() {
  const chkNhts = document.getElementById('chkNhts');
  const chkCustom = document.getElementById('chkCustomSurvey');
  const cardNhts = document.getElementById('card-nhts');
  const cardCustom = document.getElementById('card-custom-survey');
  const customOptions = document.getElementById('customSurveyOptions');

  chkNhts.addEventListener('change', () => {
    cardNhts.classList.toggle('card--selected', chkNhts.checked);
  });

  chkCustom.addEventListener('change', () => {
    cardCustom.classList.toggle('card--selected', chkCustom.checked);
    customOptions.classList.toggle('hidden', !chkCustom.checked);
  });


}

// ==========================================================================
// Panel 3 — Modes
// ==========================================================================

function setupModes() {
  const modes = ['car', 'bus', 'rail', 'walk', 'bike'];
  modes.forEach(mode => {
    const toggle = document.getElementById(`modeEnable-${mode}`);
    const card = document.getElementById(`modeCard-${mode}`);
    if (toggle && card) {
      toggle.addEventListener('change', () => {
        card.classList.toggle('mode-card--enabled', toggle.checked);
        card.classList.toggle('mode-card--disabled', !toggle.checked);
      });
    }
  });
}

// ==========================================================================
// Panel 4 — Transit
// ==========================================================================

function setupTransit() {
  const transitToggle = document.getElementById('transit-enabled');
  const transitSettings = document.getElementById('transitSettings');
  transitToggle.addEventListener('change', () => {
    transitSettings.style.display = transitToggle.checked ? 'block' : 'none';
  });
}

// ==========================================================================
// Panel 5 — Demand
// ==========================================================================

function setupDemand() {
  const targetSelect = document.getElementById('demand-target_plans');
  const customInput = document.getElementById('demand-target_plans_custom');
  targetSelect.addEventListener('change', () => {
    customInput.classList.toggle('hidden', targetSelect.value !== 'custom');
    customInput.disabled = targetSelect.value !== 'custom';
  });
}

// ==========================================================================
// Panel 6 — Time & Duration
// ==========================================================================

function buildDurationTable() {
  const tbody = document.getElementById('durationTable');
  tbody.innerHTML = '';

  DURATION_ACTIVITIES.forEach(activity => {
    const row = document.createElement('tr');
    row.style.borderBottom = '1px solid var(--color-gray-200)';
    row.innerHTML = `
      <td style="padding:8px 12px;font-weight:500;">${activity}</td>
      <td style="padding:8px 12px;">
        <input type="number" class="form-input" id="dur-${activity}-min"
               min="1" max="1440" style="width:80px;">
      </td>
      <td style="padding:8px 12px;">
        <input type="number" class="form-input" id="dur-${activity}-max"
               min="1" max="1440" style="width:80px;">
      </td>
      <td style="padding:8px 12px;">
        <select class="form-select" id="dur-${activity}-priority" style="width:120px;">
          <option value="1" >1 — Mandatory</option>
          <option value="2" >2 — Default</option>
          <option value="3" >3 — Discretionary</option>
        </select>
      </td>
    `;
    tbody.appendChild(row);
  });
}

// ==========================================================================
// Panel 7 — Simulation
// ==========================================================================

function setupSimulation() {
  const countsToggle = document.getElementById('counts-enabled');
  const countsSettings = document.getElementById('countsSettings');
  countsToggle.addEventListener('change', () => {
    countsSettings.style.display = countsToggle.checked ? 'block' : 'none';
  });

  const evalToggle = document.getElementById('eval-run');
  const evalSettings = document.getElementById('evalSettings');
  evalToggle.addEventListener('change', () => {
    evalSettings.style.display = evalToggle.checked ? 'block' : 'none';
  });
}

// ==========================================================================
// Slider value sync
// ==========================================================================

function setupSliders() {
  const sliders = [
    ['nhtsWeight',                   'nhtsWeightVal'],
    ['customSurveyWeight',           'customSurveyWeightVal'],
    ['mode-bus-blend_weight',        'mode-bus-blend_weight_val'],
    ['mode-rail-blend_weight',       'mode-rail-blend_weight_val'],
    ['demand-scaling_factor',        'demand-scaling_factor_val'],
    ['nonwork-trip_share',           'nonwork-trip_share_val'],
    ['purpose-shopping-blend_weight','purpose-shopping-blend_weight_val'],
    ['purpose-school-blend_weight',  'purpose-school-blend_weight_val'],
    ['purpose-social-blend_weight',  'purpose-social-blend_weight_val'],
    ['purpose-dining-blend_weight',  'purpose-dining-blend_weight_val'],
    ['purpose-other-blend_weight',   'purpose-other-blend_weight_val'],
    ['counts-fha_weight',            'counts-fha_weight_val'],
  ];

  sliders.forEach(([inputId, displayId]) => {
    const input = document.getElementById(inputId);
    const display = document.getElementById(displayId);
    if (input && display) {
      const update = () => {
        display.textContent = input.value === '' ? 'Not set' : String(Number(input.value));
        // Special: update scaling hint
        if (inputId === 'demand-scaling_factor') {
          const pct = (parseFloat(input.value) * 100).toFixed(1);
          document.getElementById('demand-scaling_hint').textContent = input.value === '' ?
            'Scaling factor is not set.' : `Simulating ~${pct}% of the population`;
        }
      };
      input.addEventListener('input', update);
      input.addEventListener('config-populate', update);
      update(); // init
    }
  });
}

// ==========================================================================
// Collapsible sections
// ==========================================================================

function toggleCollapsible(id) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('collapsible--open');
}

// Wire up all collapsible triggers
function setupCollapsibles() {
  document.querySelectorAll('.collapsible__trigger').forEach(trigger => {
    const collapsible = trigger.closest('.collapsible');
    if (collapsible && !trigger.hasAttribute('onclick')) {
      trigger.addEventListener('click', () => {
        collapsible.classList.toggle('collapsible--open');
      });
    }
  });
}

// ==========================================================================
// Info Popup positioning (fixed, never clipped)
// ==========================================================================

function setupInfoPopups() {
  document.querySelectorAll('.info-icon').forEach(icon => {
    const popup = icon.querySelector('.info-popup');
    if (!popup) return;

    // Move popup to body so it's never clipped by overflow
    document.body.appendChild(popup);

    function showPopup() {
      const rect = icon.getBoundingClientRect();
      const popupW = 300;
      const margin = 8;

      // Horizontal: center on the icon, but clamp to viewport
      let left = rect.left + rect.width / 2 - popupW / 2;
      left = Math.max(margin, Math.min(left, window.innerWidth - popupW - margin));

      // Vertical: prefer above the icon; if not enough room, show below
      popup.style.left = left + 'px';
      popup.style.width = popupW + 'px';
      popup.classList.remove('info-popup--above', 'info-popup--below');

      // Temporarily show to measure height
      popup.style.visibility = 'hidden';
      popup.classList.add('info-popup--visible');
      const popupH = popup.offsetHeight;
      popup.classList.remove('info-popup--visible');
      popup.style.visibility = '';

      if (rect.top - popupH - margin > 0) {
        // Above
        popup.style.top = (rect.top - popupH - margin) + 'px';
        popup.classList.add('info-popup--above');
      } else {
        // Below
        popup.style.top = (rect.bottom + margin) + 'px';
        popup.classList.add('info-popup--below');
      }

      // Adjust arrow horizontal position to point at the icon center
      const arrowLeft = rect.left + rect.width / 2 - left;
      popup.style.setProperty('--arrow-left', arrowLeft + 'px');

      popup.classList.add('info-popup--visible');
    }

    function hidePopup() {
      popup.classList.remove('info-popup--visible');
    }

    icon.addEventListener('mouseenter', showPopup);
    icon.addEventListener('mouseleave', hidePopup);
    icon.addEventListener('focus', showPopup);
    icon.addEventListener('blur', hidePopup);
  });
}

// ==========================================================================
// Purpose card expand/collapse
// ==========================================================================

function togglePurposeCard(purpose) {
  const card = document.getElementById(`purposeCard-${purpose}`);
  if (card) card.classList.toggle('purpose-card--expanded');
}

// ==========================================================================
// Export Config
// ==========================================================================

function collectFormData() {
  if (!configuration.config) throw new Error('Choose a starting configuration first.');
  return configuration.snapshot();
}

// Populate controls without dispatching edit events. Only user events write state.
function populateControl(el, value) {
  if (!el) return;
  delete el.dataset.edited;
  if (el.type === 'checkbox') {
    el.checked = value === true;
    el.indeterminate = value == null;
  } else {
    if (el.tagName === 'SELECT' && !Array.from(el.options).some(o => o.value === String(value ?? ''))) {
      const option = document.createElement('option');
      option.value = String(value ?? '');
      option.textContent = value == null ? 'Not set' : String(value);
      el.appendChild(option);
    }
    if (el.type === 'range') {
      el.step = 'any';
      if (value == null) el.type = 'number';
      else {
        el.min = Math.min(Number(el.min), Number(value));
        el.max = Math.max(Number(el.max), Number(value));
      }
    }
    el.value = value ?? '';
    el.placeholder = value == null ? 'Not set (engine default)' : el.placeholder;
  }
  el.title = value === undefined ? 'Not configured; preserved until edited.' : '';
  el.dispatchEvent(new Event('config-populate'));
}

function inputValue(el) {
  if (el.type === 'checkbox') return el.checked;
  if (el.type === 'range' || el.type === 'number' || el.id === 'counts-fha_month' || /-priority$/.test(el.id)) {
    return el.value === '' ? null : Number(el.value);
  }
  if (el.id === 'mode-car-survey_rate' && el.value !== 'auto') return el.value === '' ? null : Number(el.value);
  return el.value;
}

function refreshControlAppearance() {
  for (const mode of ['car', 'bus', 'rail', 'walk', 'bike']) {
    const enabled = document.getElementById(`modeEnable-${mode}`).checked;
    document.getElementById(`modeCard-${mode}`).classList.toggle('mode-card--enabled', enabled);
    document.getElementById(`modeCard-${mode}`).classList.toggle('mode-card--disabled', !enabled);
  }
  for (const purpose of ['shopping', 'school', 'social', 'dining', 'other']) {
    document.getElementById(`purposeCard-${purpose}`).classList.toggle('purpose-card--enabled',
      document.getElementById(`purpose-${purpose}-enabled`).checked);
  }
  for (const [control, content] of [['transit-enabled', 'transitSettings'], ['counts-enabled', 'countsSettings'], ['eval-run', 'evalSettings']]) {
    document.getElementById(content).style.display = document.getElementById(control).checked ? 'block' : 'none';
  }
  document.getElementById('demand-target_plans_custom').classList.toggle('hidden',
    document.getElementById('demand-target_plans').value !== 'custom');
  document.getElementById('demand-target_plans_custom').disabled =
    document.getElementById('demand-target_plans').value !== 'custom';
}

const SURVEY_BINDINGS = {
  customSurveyType: 'type', customSurveyYear: 'year', customSurveyWeight: 'weight',
  customSurveyFile: 'file', customSurveyPerson: 'person_file', customSurveyDay: 'day_file',
  customSurveyLinked: 'linked_trip_file',
};

function populateSurveys() {
  for (const [custom, checkbox, card] of [[false, 'chkNhts', 'card-nhts'], [true, 'chkCustomSurvey', 'card-custom-survey']]) {
    const entry = configuration.survey(custom);
    document.getElementById(checkbox).checked = !!entry;
    document.getElementById(card).classList.toggle('card--selected', !!entry);
  }
  const regional = configuration.survey(true);
  for (const [id, key] of Object.entries(SURVEY_BINDINGS)) populateControl(document.getElementById(id), regional?.[key]);
  populateControl(document.getElementById('nhtsWeight'), configuration.survey(false)?.weight);
  document.getElementById('customSurveyOptions').classList.toggle('hidden', !regional);
  document.getElementById('nhtsWeight').disabled = !configuration.survey(false);
}

function populateConfiguration() {
  for (const [id, path] of Object.entries(CONFIG_BINDINGS)) populateControl(document.getElementById(id), configuration.get(path));
  const target = configuration.get(['plan_generation', 'target_plans']);
  populateControl(document.getElementById('demand-target_plans'), target === 'all' ? 'all' : 'custom');
  populateControl(document.getElementById('demand-target_plans_custom'), target === 'all' ? undefined : target);
  document.getElementById('demand-target_plans_custom').required = target !== 'all';
  populateSurveys();
  refreshControlAppearance();
  syncSelectedRegion();
}

function setupConfigurationBindings() {
  for (const [id, path] of Object.entries(CONFIG_BINDINGS)) {
    const el = document.getElementById(id);
    if (!el) continue;
    const update = () => {
      el.dataset.edited = 'true';
      if (!configuration.config || (el.validity && !el.validity.valid)) return;
      configuration.set(path, inputValue(el));
      refreshControlAppearance();
    };
    el.addEventListener('input', update);
    el.addEventListener('change', update);
  }
  for (const [id, custom] of [['chkNhts', false], ['chkCustomSurvey', true]]) {
    document.getElementById(id).addEventListener('change', event => {
      configuration.includeSurvey(custom, event.target.checked);
      populateSurveys();
    });
  }
  for (const [id, key] of Object.entries(SURVEY_BINDINGS)) {
    document.getElementById(id).addEventListener('input', event => {
      event.target.dataset.edited = 'true';
      if (!event.target.validity.valid) return;
      const index = configuration.surveyIndex(true);
      if (index >= 0) configuration.set(['data', 'surveys', index, key], inputValue(event.target));
    });
  }
  document.getElementById('nhtsWeight').addEventListener('input', event => {
    const index = configuration.surveyIndex(false);
    if (index >= 0) configuration.set(['data', 'surveys', index, 'weight'], inputValue(event.target));
  });
  document.getElementById('demand-target_plans').addEventListener('change', event => {
    if (event.target.value === 'all') configuration.set(['plan_generation', 'target_plans'], 'all');
    else {
      const custom = document.getElementById('demand-target_plans_custom');
      custom.required = true;
      custom.dataset.edited = 'true';
      if (custom.value && custom.validity.valid) configuration.set(['plan_generation', 'target_plans'], Number(custom.value));
      custom.focus();
    }
    if (event.target.value === 'all') document.getElementById('demand-target_plans_custom').required = false;
  });
  document.getElementById('demand-target_plans_custom').addEventListener('input', event => {
    if (event.target.validity.valid && event.target.value) configuration.set(['plan_generation', 'target_plans'], Number(event.target.value));
  });
  // Existing form markup uses visual labels; give every editing control a name.
  document.querySelectorAll('.panel input, .panel select').forEach(el => {
    if (!el.labels?.length && !el.hasAttribute('aria-label')) {
      const label = el.closest('.form-group')?.querySelector('.form-label');
      el.setAttribute('aria-label', label?.childNodes[0]?.textContent.trim() || el.id.replaceAll('-', ' '));
    }
  });
}

async function fetchJSON(url) {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) throw new Error(typeof body.detail === 'string' ? body.detail : 'Unable to retrieve configuration.');
  return body;
}

function renderPresetCards() {
  const grid = document.getElementById('presetGrid');
  grid.replaceChildren();
  const options = [{id: 'custom', display_name: 'Custom Configuration', region: 'Your region',
    description: 'Start with the maintained baseline and customize your experiment.',
    characteristics: baselineConfig ? {
      counties: baselineConfig.region?.counties || [], scaling_factor: baselineConfig.plan_generation?.scaling_factor,
      surveys: baselineConfig.data?.surveys || [],
    } : {}}, ...presets];
  for (const preset of options) {
    const label = document.createElement('label');
    label.className = 'card preset-card';
    const radio = document.createElement('input');
    radio.type = 'radio'; radio.name = 'startingPreset'; radio.value = preset.id;
    radio.checked = preset.id === selectedPresetId;
    radio.disabled = preset.id === 'custom' && !baselineConfig;
    radio.addEventListener('change', () => selectPreset(preset));
    label.classList.toggle('card--selected', radio.checked);
    label.appendChild(radio);
    const content = document.createElement('div');
    const region = document.createElement('span');
    region.className = 'preset-card__region'; region.textContent = preset.region;
    const title = document.createElement('strong');
    title.className = 'card__title'; title.textContent = preset.display_name;
    const description = document.createElement('p');
    description.className = 'text-sm text-muted'; description.textContent = preset.description;
    const characteristics = preset.characteristics;
    const stats = document.createElement('p'); stats.className = 'preset-card__stats';
    const sources = (characteristics.surveys || []).filter(s => (s.weight ?? 1) > 0 || Object.values(s.roles || {}).some(w => w > 0));
    stats.textContent = `${characteristics.scaling_factor == null ? '—' : `${Number((characteristics.scaling_factor * 100).toFixed(2))}%`} population · ${sources.map(s => s.type.toUpperCase()).join(' + ') || 'Choose survey'}`;
    const counties = document.createElement('p'); counties.className = 'text-xs text-muted preset-card__counties';
    counties.dataset.counties = JSON.stringify(characteristics.counties || []);
    content.append(region, title, description, stats, counties);
    label.appendChild(content); grid.appendChild(label);
  }
  updatePresetCountyNames();
}

function updatePresetCountyNames() {
  document.querySelectorAll('[data-counties]').forEach(el => {
    const ids = JSON.parse(el.dataset.counties);
    const names = ids.map(id => countyGeoJSON?.features.find(f => f.properties.GEOID === id)?.properties.name || id);
    el.textContent = `${ids.length} ${ids.length === 1 ? 'county' : 'counties'}: ${names.join(', ')}`;
  });
}

let selectedSnapshot = null;
async function selectPreset(preset) {
  if (selectedPresetId === preset.id) {
    ++presetRequest; // Also cancel a different pending selection.
    document.getElementById('btnNext0').disabled = false;
    document.querySelectorAll('input[name="startingPreset"]').forEach(radio => {
      radio.checked = radio.value === selectedPresetId;
      radio.closest('.preset-card').classList.toggle('card--selected', radio.checked);
    });
    return; // Returning to Start retains edits.
  }
  if (selectedSnapshot && JSON.stringify(configuration.config) !== selectedSnapshot &&
      !window.confirm('Changing the starting configuration replaces your current edits. Continue?')) {
    renderPresetCards(); return;
  }
  const requestId = ++presetRequest;
  document.getElementById('btnNext0').disabled = true;
  document.getElementById('presetError').textContent = '';
  try {
    const response = preset.id === 'custom' ? {config: baselineConfig, warnings: []} :
      await fetchJSON(`/api/config/presets/${encodeURIComponent(preset.id)}`);
    if (requestId !== presetRequest) return;
    if (!response.config) throw new Error('Starting configuration is unavailable. Retry presets.');
    configuration.load(response.config);
    sourceMigrations = response.migrations || [];
    sourceWarnings = response.warnings || [];
    // Templates are used only when a user explicitly adds an absent source.
    for (const custom of [false, true]) {
      const template = baselineConfig?.data?.surveys.find(s => custom ? s.type !== 'nhts' : s.type === 'nhts');
      if (template) configuration.surveyCache[custom] = structuredClone(template);
    }
    selectedPresetId = preset.id;
    selectedSnapshot = JSON.stringify(configuration.config);
    document.body.classList.add('configuration-selected');
    populateConfiguration();
    document.querySelectorAll('.panel__badge').forEach(el => el.classList.add('hidden'));
    updateBadge('start', preset.display_name);
    document.getElementById('selectedPresetName').textContent = preset.display_name;
    document.getElementById('selectedStartingConfig').classList.remove('hidden');
    document.getElementById('presetSelectionNote').textContent = `Selected: ${preset.display_name}. Ready to customize.`;
    const warnings = document.getElementById('presetWarningList'); warnings.replaceChildren();
    for (const warning of response.warnings || []) {
      const li = document.createElement('li'); li.textContent = warning.message; warnings.appendChild(li);
    }
    document.getElementById('presetWarnings').classList.toggle('hidden', !warnings.children.length);
  } catch (error) {
    if (requestId !== presetRequest) return;
    document.getElementById('presetError').textContent = `Could not select configuration: ${error.message}`;
  } finally {
    if (requestId === presetRequest) {
      document.getElementById('btnNext0').disabled = !configuration.config;
      // Keep focus on the radio after selection, including keyboard navigation.
      document.querySelectorAll('input[name="startingPreset"]').forEach(radio => {
        radio.checked = radio.value === selectedPresetId;
        radio.closest('.preset-card').classList.toggle('card--selected', radio.checked);
      });
    }
  }
}

async function setupPresetSelection() {
  document.getElementById('btnChangePreset').onclick = () => goToStep(0);
  document.getElementById('btnRetryPresets').onclick = setupPresetSelection;
  const responses = await Promise.allSettled([fetchJSON('/api/config/presets'), fetchJSON('/api/defaults')]);
  if (responses[0].status === 'fulfilled') presets = responses[0].value.presets;
  if (responses[1].status === 'fulfilled') baselineConfig = responses[1].value;
  const failed = responses.some(result => result.status === 'rejected');
  document.getElementById('presetError').textContent = failed ? 'Some starting configurations are unavailable. Retry to retrieve them.' : '';
  document.getElementById('btnRetryPresets').classList.toggle('hidden', !failed);
  renderPresetCards();
}

function fillReviewList(id, messages) {
  const list = document.getElementById(id); list.replaceChildren();
  for (const message of messages) {
    const item = document.createElement('li'); item.textContent = message; list.appendChild(item);
  }
}

function renderChangeList(id, changes) {
  const container = document.getElementById(id); container.replaceChildren();
  if (!changes.length) { container.textContent = 'No changes.'; return; }
  for (const change of changes) {
    const item = document.createElement('details');
    const title = document.createElement('summary'); title.textContent = configPointer(change.path);
    item.appendChild(title);
    for (const [label, value] of [['Before', change.before], ['After', change.after]]) {
      const heading = document.createElement('strong'); heading.textContent = label;
      const pre = document.createElement('pre'); pre.textContent = safeReviewValue(value);
      item.append(heading, pre);
    }
    container.appendChild(item);
  }
}

function renderReview() {
  renderChangeList('reviewChanges', configDifferences(configuration.original, configuration.config));
  fillReviewList('reviewMigrations', sourceMigrations.length ? sourceMigrations.map(name => `Applied when loading: ${name}`) : ['No migrations were required when loading.']);
  fillReviewList('reviewSourceWarnings', sourceWarnings.map(warning => warning.message));
}

function draftValidationErrors() {
  const errors = advancedEditor?.errorsList() || [];
  for (const input of document.querySelectorAll('input[data-edited], select[data-edited]')) {
    if (!input.disabled && !input.validity.valid) errors.push(`${input.getAttribute('aria-label') || input.id}: ${input.validationMessage}`);
  }
  // Check supplied metadata for changed values, without rejecting unmodified
  // historical values that a newer metadata revision might not understand.
  for (const [pointer, metadata] of Object.entries(CONFIG_METADATA)) {
    const path = pointer.slice(1).split('/').map(key => key.replaceAll('~1', '/').replaceAll('~0', '~'));
    const value = configuration.get(path);
    const original = path.reduce((obj, key) => obj?.[key], configuration.original);
    if (JSON.stringify(value) === JSON.stringify(original)) continue;
    if (value === undefined && !metadata.required) continue;
    if (metadata.enum && !metadata.enum.includes(value)) errors.push(`${pointer}: choose one of ${metadata.enum.join(', ')}.`);
    if (metadata.types && !metadata.types.includes(configType(value))) errors.push(`${pointer}: expected ${metadata.types.join(' or ')}.`);
    if (typeof value === 'number' && ((metadata.integer && !Number.isInteger(value)) ||
        (metadata.minimum !== undefined && value < metadata.minimum) ||
        (metadata.maximum !== undefined && value > metadata.maximum) ||
        (metadata.exclusiveMinimum !== undefined && value <= metadata.exclusiveMinimum))) errors.push(`${pointer}: number is outside the allowed range.`);
  }
  return [...new Set(errors)];
}

function invalidateReview() {
  reviewFingerprint = null;
  ++reviewRequest;
  document.getElementById('btnExport').disabled = true;
  document.getElementById('reviewValidationStatus').textContent = 'Configuration changed. Validate before exporting.';
}

async function validateReview() {
  const request = ++reviewRequest;
  reviewFingerprint = null;
  document.getElementById('btnExport').disabled = true;
  renderReview();
  const errors = draftValidationErrors();
  fillReviewList('reviewErrors', errors);
  fillReviewList('reviewWarnings', []);
  renderChangeList('reviewAutomaticChanges', []);
  if (errors.length) {
    document.getElementById('reviewValidationStatus').textContent = 'Fix the listed editing errors before export.';
    return false;
  }
  const snapshot = configuration.snapshot(), fingerprint = JSON.stringify(snapshot);
  try {
    const response = await fetch('/api/config/prepare', {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({config: snapshot}),
    });
    const result = await response.json();
    if (request !== reviewRequest || fingerprint !== JSON.stringify(configuration.config)) return false;
    if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : 'Configuration validation failed.');
    fillReviewList('reviewWarnings', (result.issues || []).map(issue => `${issue.path ? issue.path + ': ' : ''}${issue.message}`));
    const migrations = [...sourceMigrations.map(name => `Applied when loading: ${name}`),
      ...(result.migrations || []).map(name => `Will apply on export: ${name}`)];
    fillReviewList('reviewMigrations', migrations.length ? migrations : ['No compatibility migrations.']);
    renderChangeList('reviewAutomaticChanges', configDifferences(snapshot, result.config));
    document.getElementById('reviewValidationStatus').textContent = 'Structural validation passed. Review warnings; data files and machine readiness have not been checked.';
    reviewFingerprint = fingerprint;
    document.getElementById('btnExport').disabled = false;
    return true;
  } catch (error) {
    if (request !== reviewRequest) return false;
    fillReviewList('reviewErrors', [error.message]);
    document.getElementById('reviewValidationStatus').textContent = 'Validation did not pass. Fix the configuration or retry.';
    return false;
  }
}

function setupAdvancedAndReview() {
  advancedEditor = new AdvancedConfigEditor(configuration, document.getElementById('advancedEditor'), {}, () => baselineConfig);
  const overlaps = (left, right) => left.slice(0, Math.min(left.length, right.length)).every((key, index) => key === right[index]);
  configuration.subscribe(change => {
    invalidateReview();
    if (change.source !== 'advanced') return;
    for (const [id, path] of Object.entries(CONFIG_BINDINGS)) {
      if (overlaps(change.path, path)) populateControl(document.getElementById(id), configuration.get(path));
    }
    if (overlaps(change.path, ['data', 'surveys'])) populateSurveys();
    if (overlaps(change.path, ['region', 'counties'])) syncSelectedRegion();
    if (overlaps(change.path, ['plan_generation', 'target_plans'])) {
      const target = configuration.get(['plan_generation', 'target_plans']);
      populateControl(document.getElementById('demand-target_plans'), target === 'all' ? 'all' : 'custom');
      populateControl(document.getElementById('demand-target_plans_custom'), target === 'all' ? undefined : target);
    }
    refreshControlAppearance();
  });
  document.getElementById('advancedEditor').addEventListener('editor-validation', invalidateReview);
  document.getElementById('btnValidateConfig').onclick = validateReview;
}

async function exportConfig() {
  try {
    if (!validateStep(currentStep)) return;
    const inputs = document.querySelectorAll('input[data-edited], select[data-edited]');
    for (const el of inputs) { if (!el.reportValidity()) return; }
    if (STEPS[currentStep].id !== 'review') {
      goToStep(STEPS.findIndex(step => step.id === 'review'));
      return;
    }
    if (reviewFingerprint !== JSON.stringify(configuration.config) || advancedEditor.errorsList().length) {
      await validateReview();
      return; // The user reviews the result before another explicit export click.
    }
    const formData = collectFormData();
    const resp = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formData),
    });
    const config = await resp.json();
    if (!resp.ok) {
      reviewFingerprint = null;
      document.getElementById('btnExport').disabled = true;
      throw new Error(config.detail || 'Configuration could not be exported.');
    }

    // Download as file
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'config.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error('Export failed:', err);
    fillReviewList('reviewErrors', [`Export failed: ${err.message}`]);
  }
}

// ==========================================================================
// Utilities
// ==========================================================================

function formatNumber(n) {
  if (n == null) return '0';
  return n.toLocaleString('en-US');
}

// ==========================================================================
// Init
// ==========================================================================

document.addEventListener('DOMContentLoaded', () => {
  renderStepProgress();
  setupNavigation();
  if (typeof L !== 'undefined') initMap();
  else document.getElementById('mapMessage').textContent = 'Map unavailable. You can still remove selected counties and edit settings.';
  setupSurveys();
  setupModes();
  setupTransit();
  setupDemand();
  buildDurationTable();
  setupSimulation();
  setupSliders();
  setupCollapsibles();
  setupInfoPopups();
  setupConfigurationBindings();
  setupAdvancedAndReview();
  setupPresetSelection();

  // Export button
  document.getElementById('btnExport').addEventListener('click', exportConfig);
});
