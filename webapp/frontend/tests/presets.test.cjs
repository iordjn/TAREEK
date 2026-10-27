const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const {ConfigurationState, CONFIG_BINDINGS} = require('../js/config-state.js');

const root = path.resolve(__dirname, '../../..');
const frontend = path.resolve(__dirname, '..');
const ids = fs.readdirSync(path.join(root, 'examples')).filter(id =>
  fs.existsSync(path.join(root, 'examples', id, 'config_used.json')));
function normalized(config) {
  config = structuredClone(config);
  delete config._config_dir; delete config._demand_budget;
  delete config.coordinates.utm_epsg;
  delete config.matsim._survey_typical_durations; delete config.matsim._survey_activity_params;
  config.network.roundabout_capacity_per_lane ??= null;
  return config;
}
const baseline = normalized(JSON.parse(fs.readFileSync(path.join(root, 'config/config_local.json'))));
const examples = Object.fromEntries(ids.map(id => [id, normalized(JSON.parse(fs.readFileSync(
  path.join(root, 'examples', id, 'config_used.json'))))]));
const metadata = ids.map(id => ({id, display_name: id, region: id.split('-')[0], description: `Experiment ${id}`,
  characteristics: {counties: examples[id].region.counties, scaling_factor: examples[id].plan_generation.scaling_factor,
    surveys: examples[id].data.surveys}}));
const clone = value => JSON.parse(JSON.stringify(value));

async function browser(t, intercept) {
  const dom = new JSDOM(fs.readFileSync(path.join(frontend, 'index.html'), 'utf8'), {
    runScripts: 'outside-only', url: 'http://localhost:8000/',
  });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.structuredClone = structuredClone;
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.HTMLAnchorElement.prototype.click = () => {};
  w.URL.createObjectURL = () => 'blob:test'; w.URL.revokeObjectURL = () => {};
  w.confirm = () => true;
  w.alert = message => { throw new Error(message); };
  const requests = [];
  w.fetch = async (url, options) => {
    requests.push({url, options});
    const intercepted = intercept?.(url, options);
    if (intercepted) return intercepted;
    let body;
    if (url === '/api/config/presets') body = {presets: metadata};
    else if (url === '/api/defaults') body = baseline;
    else if (url.startsWith('/api/config/presets/')) body = {
      config: examples[url.split('/').at(-1)], warnings: [{message: 'Review data paths.'}],
    };
    else if (url === '/api/export') body = JSON.parse(options.body);
    else if (url === '/api/config/prepare') body = {config: JSON.parse(options.body).config,
      issues: [{path: 'data.data_dir', message: 'Verify data path.'}], migrations: []};
    else throw new Error(`Unexpected URL: ${url}`);
    return {ok: true, json: async () => structuredClone(body)};
  };
  w.eval(fs.readFileSync(path.join(frontend, 'js/config-state.js'), 'utf8') + '\n' +
    fs.readFileSync(path.join(frontend, 'js/advanced-editor.js'), 'utf8') + '\n' +
    fs.readFileSync(path.join(frontend, 'js/app.js'), 'utf8') + `
    window.testApi = {configuration, collectFormData, selectPreset, populateConfiguration,
      goToStep, validateStep, validateReview, renderReview, removeCounty, toggleCounty, syncSelectedRegion, exportConfig,
      get editor() { return advancedEditor; }};`);
  await new Promise(resolve => w.addEventListener('DOMContentLoaded', resolve, {once: true}));
  await new Promise(resolve => setImmediate(resolve));
  return {w, api: w.testApi, requests, document: w.document};
}

test('starting step offers custom and all experiment variants with native keyboard controls', async t => {
  const {document} = await browser(t);
  const radios = [...document.querySelectorAll('input[name="startingPreset"]')];
  assert.equal(radios.length, ids.length + 1);
  assert.equal(radios[0].value, 'custom');
  assert.ok(radios.every(r => r.closest('label') && r.closest('fieldset')));
  assert.ok(document.getElementById('panel-start').classList.contains('panel--active'));
  assert.equal(document.getElementById('btnNext0').disabled, true);
  assert.equal(document.querySelectorAll('.step-progress__item').length, 10);
  assert.ok(document.querySelectorAll('.step-progress__item')[0].matches('button[aria-current="step"]'));
});

for (const id of ids) test(`${id}: hydration and export preserve all parameters`, async t => {
  const {api, document, requests} = await browser(t);
  await api.selectPreset(metadata.find(p => p.id === id));
  assert.deepEqual(clone(api.collectFormData()), examples[id]);
  assert.equal(document.getElementById('sim-iterations').value, String(examples[id].matsim.configurable_params.lastIteration));
  assert.equal(document.getElementById('demand-scaling_factor').value, String(examples[id].plan_generation.scaling_factor));
  assert.equal(document.getElementById('demand-scaling_factor_val').textContent, String(examples[id].plan_generation.scaling_factor));
  assert.equal(document.getElementById('selectedPresetName').textContent, id);
  assert.equal(document.querySelectorAll('.card--selected.preset-card').length, 1);
  assert.equal(document.getElementById('btnNext0').disabled, false);
  // Map metadata arriving later must not reorder county arrays or alter state.
  api.syncSelectedRegion();
  assert.deepEqual(clone(api.collectFormData()), examples[id]);
  api.goToStep(9);
  await api.validateReview();
  await api.exportConfig();
  assert.deepEqual(JSON.parse(requests.find(r => r.url === '/api/export').options.body), examples[id]);
});

test('one edit changes only the bound leaf and preserves dotted MATSim keys/freight', async t => {
  const {w, api, document} = await browser(t);
  const id = 'losangeles-20261006';
  await api.selectPreset(metadata.find(p => p.id === id));
  const input = document.getElementById('sim-flow_capacity');
  input.value = '0.2'; input.dispatchEvent(new w.Event('input'));
  const expected = structuredClone(examples[id]); expected.matsim.configurable_params['qsim.flowCapacityFactor'] = 0.2;
  assert.deepEqual(clone(api.collectFormData()), expected);
  assert.equal(api.configuration.get(['matsim', 'configurable_params', 'controller.mobsim']), 'hermes');
  // Switching back to Start and reselecting the current experiment retains edits.
  await api.selectPreset(metadata.find(p => p.id === id));
  assert.deepEqual(clone(api.collectFormData()), expected);
});

test('every declared control binding exists and hydration does not use HTML fallback values', async t => {
  const {api, document} = await browser(t);
  await api.selectPreset({id: 'custom', display_name: 'Custom Configuration'});
  assert.deepEqual(clone(api.collectFormData()), baseline);
  for (const [id, keys] of Object.entries(CONFIG_BINDINGS)) {
    const input = document.getElementById(id);
    assert.ok(input, id);
    const value = keys.reduce((v, k) => v?.[k], baseline);
    if (input.type === 'checkbox') assert.equal(input.checked, value === true, id);
    else assert.equal(input.value, String(value ?? ''), id);
  }
  assert.equal(document.getElementById('sim-iterations').value, '5');
});

test('survey edits retain role weights and files, and disabling/re-enabling restores exact arrays', async t => {
  const {w, api, document} = await browser(t);
  const id = 'birmingham-localsurvey-20261001';
  await api.selectPreset(metadata.find(p => p.id === id));
  assert.equal(document.getElementById('customSurveyType').value, 'bham_local');
  assert.equal(document.getElementById('nhtsWeight').value, '0');
  assert.ok(document.getElementById('customSurveyFile').value.includes('birmingham'));
  const toggle = document.getElementById('chkCustomSurvey');
  toggle.checked = false; toggle.dispatchEvent(new w.Event('change'));
  toggle.checked = true; toggle.dispatchEvent(new w.Event('change'));
  assert.deepEqual(clone(api.collectFormData()), examples[id]);
  const input = document.getElementById('customSurveyWeight');
  input.value = '0.5'; input.dispatchEvent(new w.Event('input'));
  const expected = structuredClone(examples[id]); expected.data.surveys[0].weight = 0.5;
  assert.deepEqual(clone(api.collectFormData()), expected);
});

test('region remains customizable above the former population cap', async t => {
  const {api} = await browser(t);
  const id = 'losangeles-20261006';
  await api.selectPreset(metadata.find(p => p.id === id));
  assert.equal(api.validateStep(1), true);
  api.toggleCounty('06001', 'Alameda', 10_000_000, {}, {setStyle() {}});
  assert.ok(api.collectFormData().region.counties.includes('06001'));
  api.removeCounty('06001');
  assert.deepEqual(clone(api.collectFormData()), examples[id]);
});

test('a failed selection retains the previous config and shows a retryable error', async t => {
  const {api, document} = await browser(t, url => url.endsWith('/newyork-20261006') ?
    Promise.resolve({ok: false, json: async () => ({detail: 'Unavailable'})}) : null);
  await api.selectPreset(metadata.find(p => p.id === 'madison-20260928'));
  await api.selectPreset(metadata.find(p => p.id === 'newyork-20261006'));
  assert.ok(document.getElementById('presetError').textContent.includes('Unavailable'));
  assert.deepEqual(clone(api.collectFormData()), examples['madison-20260928']);
  assert.equal(document.getElementById('btnNext0').disabled, false);
});

test('all wizard navigation works after selecting a large preset', async t => {
  const {api, document} = await browser(t);
  await api.selectPreset(metadata.find(p => p.id === 'losangeles-20261006'));
  const panels = ['region', 'surveys', 'modes', 'transit', 'demand', 'time', 'simulation'];
  for (const [i, panel] of panels.entries()) {
    document.getElementById(`btnNext${i}`).click();
    assert.ok(document.getElementById(`panel-${panel}`).classList.contains('panel--active'), panel);
    assert.equal(document.activeElement, document.querySelector(`#panel-${panel} .panel__title`));
  }
  document.getElementById('btnBack7').click();
  assert.ok(document.getElementById('panel-time').classList.contains('panel--active'));
  assert.deepEqual(clone(api.collectFormData()), examples['losangeles-20261006']);
});

test('invalid edited controls prevent export instead of silently exporting stale state', async t => {
  const {w, api, document, requests} = await browser(t);
  await api.selectPreset(metadata.find(p => p.id === 'losangeles-20261006'));
  const input = document.getElementById('sim-flow_capacity');
  input.value = '0'; input.dispatchEvent(new w.Event('input'));
  await api.exportConfig();
  assert.equal(requests.some(r => r.url === '/api/export'), false);
});

test('out-of-order selection responses cannot replace the last selection', async t => {
  let resolveFirst;
  const {api} = await browser(t, url => url.endsWith('/losangeles-20261006') ?
    new Promise(resolve => { resolveFirst = resolve; }) : null);
  const first = api.selectPreset(metadata.find(p => p.id === 'losangeles-20261006'));
  await api.selectPreset(metadata.find(p => p.id === 'madison-20260928'));
  resolveFirst({ok: true, json: async () => ({config: examples['losangeles-20261006']})});
  await first;
  assert.deepEqual(clone(api.collectFormData()), examples['madison-20260928']);
});

test('model preserves arrays, nulls and unknown extension parameters', () => {
  const state = new ConfigurationState();
  const source = {...baseline, extension: {array: [null, false, {extra: 1}]}};
  state.load(source);
  state.set(['matsim', 'configurable_params', 'new.module.key'], false);
  assert.deepEqual(state.snapshot().extension, source.extension);
  assert.equal(state.get(['matsim', 'configurable_params', 'new.module.key']), false);
  assert.equal(source.matsim.configurable_params['new.module.key'], undefined);
});

function advancedInput(document, pointer) {
  const input = [...document.querySelectorAll('[data-config-pointer]')].find(el => el.dataset.configPointer === pointer);
  assert.ok(input, pointer); return input;
}
function advancedField(document, pointer) {
  const field = [...document.querySelectorAll('[data-pointer]')].find(el => el.dataset.pointer === pointer);
  assert.ok(field, pointer); return field;
}
function edit(w, input, value) {
  if (input.type === 'checkbox') input.checked = value;
  else input.value = String(value);
  input.dispatchEvent(new w.Event('input', {bubbles: true}));
}

test('advanced freight and literal dotted MATSim edits synchronize both ways with wizard controls', async t => {
  const {w, api, document} = await browser(t);
  const id = 'losangeles-20261006';
  await api.selectPreset(metadata.find(p => p.id === id));
  edit(w, advancedInput(document, '/matsim/configurable_params/qsim.flowCapacityFactor'), 0.25);
  assert.equal(document.getElementById('sim-flow_capacity').value, '0.25');
  edit(w, document.getElementById('sim-flow_capacity'), 0.3);
  assert.equal(advancedInput(document, '/matsim/configurable_params/qsim.flowCapacityFactor').value, '0.3');
  edit(w, advancedInput(document, '/freight/demand_scale'), 0.4);
  edit(w, advancedInput(document, '/matsim/configurable_params/hermes.endTime'), '40:00:00');
  edit(w, advancedInput(document, '/freight/pce/enabled'), true);
  const expected = structuredClone(examples[id]);
  expected.matsim.configurable_params['qsim.flowCapacityFactor'] = 0.3;
  expected.matsim.configurable_params['hermes.endTime'] = '40:00:00';
  expected.freight.demand_scale = 0.4; expected.freight.pce.enabled = true;
  assert.deepEqual(clone(api.collectFormData()), expected);
  assert.deepEqual(clone(api.configuration.original), examples[id]);
  const review = await api.validateReview(); assert.equal(review, true);
  assert.ok(document.getElementById('reviewChanges').textContent.includes('/freight/pce/enabled'));
});

test('advanced arrays, nullable values and new nested objects retain all unrelated settings', async t => {
  const {w, api, document} = await browser(t);
  await api.selectPreset(metadata[0]);
  api.configuration.set(['extension'], {values: [null, true, {'literal.key': 2}], nullable: null});
  const nullField = advancedField(document, '/extension/nullable');
  const type = nullField.querySelector('.advanced-type');
  type.value = 'number'; type.dispatchEvent(new w.Event('change'));
  edit(w, advancedInput(document, '/extension/nullable'), 8);
  assert.equal(api.configuration.get(['extension', 'nullable']), 8);
  const backToNull = advancedField(document, '/extension/nullable').querySelector('.advanced-type');
  backToNull.value = 'null'; backToNull.dispatchEvent(new w.Event('change'));
  edit(w, advancedInput(document, '/extension/values/1'), false);
  edit(w, advancedInput(document, '/extension/values/2/literal.key'), 5);
  const array = advancedField(document, '/extension/values');
  const add = [...array.querySelectorAll('button')].find(button => button.textContent === 'Add item');
  add.click();
  assert.deepEqual(clone(api.configuration.get(['extension'])), {values: [null, false, {'literal.key': 5}, null], nullable: null});
  const remove = [...advancedField(document, '/extension/values/3').querySelectorAll('button')].find(button => button.textContent === 'Remove item 3');
  remove.click();
  const expected = structuredClone(examples[metadata[0].id]);
  expected.extension = {values: [null, false, {'literal.key': 5}], nullable: null};
  assert.deepEqual(clone(api.collectFormData()), expected);
});

test('metadata supplies help, allowed values and number validation; invalid drafts block export', async t => {
  const {w, api, document, requests} = await browser(t);
  await api.selectPreset(metadata[0]);
  assert.equal(advancedInput(document, '/od_matrix/friction').tagName, 'SELECT');
  assert.ok([...advancedInput(document, '/od_matrix/friction').options].some(o => o.value === 'gamma'));
  assert.ok(advancedField(document, '/od_matrix/friction').textContent.includes('bounded'));
  const input = advancedInput(document, '/matsim/configurable_params/lastIteration');
  edit(w, input, -1);
  assert.ok(api.editor.errorsList().length);
  assert.equal(await api.validateReview(), false);
  assert.equal(document.getElementById('btnExport').disabled, true);
  assert.ok(document.getElementById('reviewErrors').textContent.includes('lastIteration'));
  edit(w, document.getElementById('chain-max_work'), 3); // Unrelated GUI edit retains invalid draft.
  assert.equal(advancedInput(document, '/matsim/configurable_params/lastIteration').value, '-1');
  edit(w, advancedInput(document, '/matsim/configurable_params/lastIteration'), 7);
  assert.equal(await api.validateReview(), true);
  assert.equal(document.getElementById('sim-iterations').value, '7');
  assert.ok(!requests.some(r => r.url === '/api/export'));
});

test('private credentials/runtime fields stay out of editor and review while state is retained', async t => {
  const {api, document} = await browser(t);
  await api.selectPreset(metadata[0]);
  api.configuration.set(['extension'], {api_key: 'SENSITIVE_API', password: 'SENSITIVE_PASS',
    url: 'https://user:SENSITIVE_URL@example.org/path', ordinary: true});
  api.configuration.set(['_demand_budget'], {hidden: 'SENSITIVE_RUNTIME'});
  api.configuration.set(['coordinates', 'utm_epsg'], 'EPSG:26915');
  api.renderReview();
  assert.ok(!document.getElementById('advancedEditor').textContent.includes('SENSITIVE_'));
  assert.ok(!document.getElementById('reviewChanges').textContent.includes('SENSITIVE_'));
  assert.equal(api.configuration.get(['extension', 'api_key']), 'SENSITIVE_API');
  assert.equal(document.querySelector('[data-config-pointer="/coordinates/utm_epsg"]'), null);
  assert.equal(advancedField(document, '/extension').querySelector('.advanced-type').disabled, true);
});

test('review distinguishes source migrations from user changes and shows portability warnings', async t => {
  const {api, document} = await browser(t, url => url.endsWith('/madison-20260928') ?
    Promise.resolve({ok: true, json: async () => ({config: examples['madison-20260928'],
      migrations: ['explicit_no_roundabout_capacity_override'], warnings: [{message: 'Original engine version unverified.'}]})}) : null);
  await api.selectPreset(metadata.find(p => p.id === 'madison-20260928'));
  assert.equal(await api.validateReview(), true);
  assert.equal(document.getElementById('reviewChanges').textContent, 'No changes.');
  assert.ok(document.getElementById('reviewMigrations').textContent.includes('Applied when loading'));
  assert.ok(document.getElementById('reviewWarnings').textContent.includes('Verify data path.'));
  assert.ok(document.getElementById('reviewSourceWarnings').textContent.includes('Original engine version'));
  api.configuration.set(['freight', 'demand_scale'], 0.8, 'advanced');
  assert.equal(document.getElementById('btnExport').disabled, true);
});

test('backend validation errors are shown before export', async t => {
  const {api, document, requests} = await browser(t, url => url === '/api/config/prepare' ?
    Promise.resolve({ok: false, json: async () => ({detail: 'region.counties must contain five-digit GEOIDs'})}) : null);
  await api.selectPreset(metadata[0]);
  assert.equal(await api.validateReview(), false);
  assert.ok(document.getElementById('reviewErrors').textContent.includes('region.counties'));
  assert.equal(document.getElementById('btnExport').disabled, true);
  assert.equal(requests.some(r => r.url === '/api/export'), false);
});

test('editing while validation is pending prevents a stale result from enabling export', async t => {
  let resolveValidation;
  const {api, document} = await browser(t, (url, options) => url === '/api/config/prepare' ?
    new Promise(resolve => { resolveValidation = () => resolve({ok: true, json: async () => ({
      config: JSON.parse(options.body).config, issues: [], migrations: [],
    })}); }) : null);
  await api.selectPreset(metadata[0]);
  const validation = api.validateReview();
  api.configuration.set(['freight', 'demand_scale'], 0.75, 'advanced');
  resolveValidation();
  assert.equal(await validation, false);
  assert.equal(document.getElementById('btnExport').disabled, true);
});

test('pending backend migrations are reviewed without silently mutating the edited state', async t => {
  const {api, document} = await browser(t, (url, options) => {
    if (url !== '/api/config/prepare') return null;
    const config = JSON.parse(options.body).config;
    config.network.roundabout_capacity_per_lane = null;
    return Promise.resolve({ok: true, json: async () => ({config, issues: [],
      migrations: ['explicit_no_roundabout_capacity_override']})});
  });
  await api.selectPreset(metadata[0]);
  const network = clone(api.configuration.get(['network']));
  delete network.roundabout_capacity_per_lane;
  api.configuration.set(['network'], network, 'advanced');
  assert.equal(await api.validateReview(), true);
  assert.ok(document.getElementById('reviewMigrations').textContent.includes('Will apply on export'));
  assert.ok(document.getElementById('reviewAutomaticChanges').textContent.includes('/network/roundabout_capacity_per_lane'));
  assert.equal(Object.hasOwn(api.configuration.get(['network']), 'roundabout_capacity_per_lane'), false);
});
