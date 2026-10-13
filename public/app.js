let modules = ['Ajuste de honorários', 'Ajuste de exame laboratorial', 'Ajuste de exame de imagem', 'Glosa de honorário médico', 'Glosa de taxa', 'Glosa de material', 'Glosa de medicamento', 'Glosa de exame de imagem', 'Glosa de exame laboratorial', 'Glosa de nutrição', 'Glosa de OPME', 'Glosa de fisioterapia'];
const $ = (selector, root = document) => root.querySelector(selector);
const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const DEFAULT_ADJUSTMENT_JUSTIFICATION = 'Ajuste, será pago R$ conforme as regras da CBHPM Edição 2014 e de acordo com o item 5 do referencial de custos do contrato.';
let activeModule = modules[0];
let showAll = false;
let draftTimer;
let currentSession;
let guideFilter = '';
let currentGuideStatus = 'RASCUNHO';
let currentGuideEditable = true;
let justificationOptions = [];
let ocsOptions = [], patientOptions = [], specificationOptions = [];
let justificationTarget;
let manualJustificationTarget;
const draftKey = 'pmgu-guide-draft';
// Nova chave: a antiga gravava o tema do sistema automaticamente e prenderia todos no escuro.
const themeKey = 'sisglosa-theme';
const routes = { dashboard: '/', guide: '/guias', recent: '/registros', admin: '/administracao', developer: '/desenvolvedor' };
const routeScreen = Object.fromEntries(Object.entries(routes).map(([screen, route]) => [route, screen]));

function isHonor(module) { return module.includes('honorário'); }
function setTheme(theme) { document.documentElement.dataset.theme = theme; const label = theme === 'dark' ? 'Ativar modo claro' : 'Ativar modo escuro'; $('#theme-icon').className = `bi bi-${theme === 'dark' ? 'sun' : 'moon-stars'}`; $('#theme-toggle').setAttribute('aria-pressed', String(theme === 'dark')); $('#theme-toggle').setAttribute('aria-label', label); $('#theme-toggle').title = label; }
function isAdjustment(module) { return module.startsWith('Ajuste'); }
function amount(value) { return Number(String(value ?? '').replace(/[^0-9,-]/g, '').replace(/\./g, '').replace(',', '.')) || 0; }
function format(value) { return money.format(Number(value || 0)); }
function cents(value) { return (Number(String(value ?? '').replace(/\D/g, '')) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function bindSuggestions(input, values) { const menu = $('#custom-suggestions'); const show = () => { const matches = values().filter((value) => value.toLocaleLowerCase('pt-BR').includes(input.value.trim().toLocaleLowerCase('pt-BR'))).slice(0, 8); menu.replaceChildren(...matches.map((value) => { const option = Object.assign(document.createElement('button'), { type: 'button', textContent: value }); option.onclick = () => { input.value = value; menu.hidden = true; input.dispatchEvent(new Event('input', { bubbles: true })); }; return option; })); if (!matches.length) return menu.hidden = true; const box = input.getBoundingClientRect(); Object.assign(menu.style, { left: `${box.left + scrollX}px`, top: `${box.bottom + scrollY + 5}px`, width: `${box.width}px` }); menu.hidden = false; }; input.addEventListener('focus', show); input.addEventListener('input', show); input.addEventListener('blur', () => setTimeout(() => { menu.hidden = true; }, 150)); }
function bindMoneyInput(input) { input.addEventListener('focus', (event) => event.target.select()); input.addEventListener('input', (event) => { event.target.value = cents(event.target.value); totals(); persistDraft(); }); }
function dateTime(value) { if (!value) return '—'; const text = String(value); return new Date(text.endsWith('Z') ? text : `${text}Z`).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }); }
function escape(value) { return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]); }
function adjustmentText(value) { return DEFAULT_ADJUSTMENT_JUSTIFICATION.replace('R$ ', `R$ ${value} `); }
function adjustmentValue(text) { return String(text || '').match(/^Ajuste, será pago R\$\s*(.*?)\s*conforme as regras da CBHPM Edição 2014 e de acordo com o item 5 do referencial de custos do contrato\.$/)?.[1] || '0,00'; }
function toast(message, type = '') { const box = $('#toast'); box.textContent = message; box.className = `show ${type}`; clearTimeout(box.timer); box.timer = setTimeout(() => { box.className = ''; }, 3600); }
function emptyRow(target, columns, message) { const row = document.createElement('tr'); const cell = Object.assign(document.createElement('td'), { className: 'empty-cell', colSpan: columns, textContent: message }); row.append(cell); target.append(row); }
function confirmAction(message, { title = 'Confirmar ação', confirm = 'Confirmar', danger = false } = {}) {
  return new Promise((resolve) => {
    const modal = $('#confirm-modal'); const accept = $('#modal-confirm'); const cancel = $('#modal-cancel');
    $('#modal-title').textContent = title; $('#modal-message').textContent = message; accept.textContent = confirm; accept.classList.toggle('danger', danger); modal.hidden = false;
    const close = (value) => { modal.hidden = true; accept.onclick = cancel.onclick = null; document.removeEventListener('keydown', keydown); resolve(value); };
    const keydown = (event) => { if (event.key === 'Escape') close(false); };
    accept.onclick = () => close(true); cancel.onclick = () => close(false); modal.onclick = (event) => { if (event.target === modal) close(false); }; document.addEventListener('keydown', keydown); accept.focus();
  });
}
async function api(url, options = {}) {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
  if (response.status === 401) { showLogin(); throw new Error('Sessão expirada.'); }
  if (!response.ok) throw new Error(data?.error || 'Não foi possível concluir a operação.');
  return data;
}
function showLogin() { currentSession = null; history.replaceState(null, '', '/login'); $('#app-view').hidden = true; $('#app-view').style.display = 'none'; $('#password-view').hidden = true; $('#login-view').hidden = false; $('#login-view').style.display = 'grid'; document.body.classList.remove('loading'); }
function showPasswordView() { $('#login-view').hidden = true; $('#login-view').style.display = 'none'; $('#app-view').hidden = true; $('#password-view').hidden = false; $('#password-view').style.display = 'grid'; document.body.classList.remove('loading'); $('#password-form').reset(); $('#password-form input').focus(); }
function showApp(session) { currentSession = session; const admin = session.role === 'admin'; const screen = routeScreen[location.pathname]; const requestedGuide = Number(new URLSearchParams(location.search).get('guia')); $('#username').textContent = session.username; document.querySelectorAll('.admin-only').forEach((item) => { item.hidden = !admin; }); document.querySelectorAll('.guide-only').forEach((item) => { item.hidden = admin; }); $('#login-view').hidden = true; $('#login-view').style.display = 'none'; $('#password-view').hidden = true; $('#app-view').hidden = false; $('#app-view').style.display = 'block'; document.body.classList.remove('loading'); if (admin) return navigate(screen === 'developer' ? 'developer' : 'admin', !['admin', 'developer'].includes(screen)); resetGuide(); restoreDraft(); totals(); loadOcs(); loadModules(); loadJustifications(); loadRecent(); navigate(['dashboard', 'guide', 'recent'].includes(screen) ? screen : 'dashboard', !['dashboard', 'guide', 'recent'].includes(screen)); if (screen === 'guide' && Number.isInteger(requestedGuide) && requestedGuide > 0) openGuide(requestedGuide); }

function moduleOptions(selected) {
  return ['Ajuste', 'Glosa'].map((prefix) => `<optgroup label="${prefix}s">${modules.filter((module) => module.startsWith(prefix)).map((module) => `<option value="${escape(module)}" ${module === selected ? 'selected' : ''}>${escape(module)}</option>`).join('')}</optgroup>`).join('');
}
function refreshModuleOptions() { const selected = $('#add-module').value || activeModule; $('#add-module').innerHTML = moduleOptions(selected); if (modules.includes(selected)) $('#add-module').value = selected; rows().forEach((row) => { const current = $('.module', row).value; $('.module', row).innerHTML = moduleOptions(current); }); }
function setItemMode(mode) { const custom = mode === 'custom'; $('#existing-module-field').hidden = custom; $('#custom-module-fields').hidden = !custom; document.querySelectorAll('.item-mode').forEach((button) => { const selected = button.dataset.mode === mode; button.classList.toggle('active', selected); button.setAttribute('aria-selected', selected); }); $('#item-modal-submit').textContent = custom ? 'Criar e adicionar' : 'Adicionar item'; }
function closeItemModal() { $('#item-modal').hidden = true; }
function openItemModal() { setItemMode('existing'); $('#item-modal').hidden = false; $('#add-module').value = activeModule; $('#add-module').focus(); }
function applySavedJustification(value) { justificationTarget.value = value; closeJustificationModal(); totals(); persistDraft(); }
async function saveJustification(value) { const justification = value.trim(); if (!justification) { toast('Digite uma justificativa antes de salvá-la.', 'error'); return false; } try { await api('/api/options/justifications', { method: 'POST', body: JSON.stringify({ justification }) }); await loadJustifications(); toast('Justificativa salva para reutilização.', 'success'); return true; } catch (error) { toast(error.message, 'error'); return false; } }
async function deleteSavedJustification(value) { if (!await confirmAction('A justificativa será removida apenas da lista de sugestões. Guias e relatórios já registrados não serão alterados.', { title: 'Excluir justificativa salva', confirm: 'Excluir', danger: true })) return; try { await api('/api/options/justifications', { method: 'DELETE', body: JSON.stringify({ justification: value }) }); toast('Justificativa removida das sugestões.', 'success'); await loadJustifications(); } catch (error) { toast(error.message, 'error'); } }
function renderSavedJustifications(query = '') { const list = $('#saved-justification-list'); const values = justificationOptions.filter((value) => value.toLocaleLowerCase('pt-BR').includes(query.trim().toLocaleLowerCase('pt-BR'))); list.replaceChildren(); if (!values.length) return list.append(Object.assign(document.createElement('p'), { className: 'suggestion-empty', textContent: query ? 'Nenhuma justificativa encontrada.' : 'Ainda não há justificativas salvas.' })); values.forEach((value) => { const row = Object.assign(document.createElement('div'), { className: 'saved-justification' }); const option = Object.assign(document.createElement('button'), { type: 'button', className: 'suggestion-option', textContent: value }); option.onclick = () => applySavedJustification(value); row.append(option); if (value === DEFAULT_ADJUSTMENT_JUSTIFICATION) row.append(Object.assign(document.createElement('span'), { className: 'saved-justification-standard', textContent: 'Padrão' })); else { const remove = Object.assign(document.createElement('button'), { type: 'button', className: 'delete-saved-justification', textContent: 'Excluir', ariaLabel: 'Excluir justificativa salva' }); remove.onclick = () => deleteSavedJustification(value); row.append(remove); } list.append(row); }); }
function closeJustificationModal() { $('#justification-modal').hidden = true; $('#saved-adjustment-value-field').hidden = true; justificationTarget = null; }
function openJustificationModal(target) { justificationTarget = target; $('#saved-justification-search').value = ''; $('#new-saved-justification').value = ''; $('#saved-adjustment-value-field').hidden = true; renderSavedJustifications(); $('#justification-modal').hidden = false; $('#saved-justification-search').focus(); }
function closeManualJustificationModal() { $('#manual-justification-modal').hidden = true; manualJustificationTarget = null; }
function openManualJustificationModal(target) { manualJustificationTarget = target; $('#manual-justification-text').value = target.value; $('#manual-justification-modal').hidden = false; $('#manual-justification-text').focus(); }
function setJustificationMode(row) { $('.justification-composer', row).hidden = false; }
function rowValues(row) { return { module: $('.module', row).value, specification: $('.specification', row).value, specialty: $('.specialty', row).value, crm: $('.crm', row).value, justification: $('.justification', row).value, amount: amount($('.amount', row).value) }; }
function rows() { return [...$('#items').rows]; }
function addItem(module = activeModule, item = {}) {
  if (!modules.includes(item.module || module)) modules.push(item.module || module);
  const row = $('#item-template').content.firstElementChild.cloneNode(true);
  $('.module', row).innerHTML = moduleOptions(item.module || module);
  bindSuggestions($('.specification', row), () => specificationOptions);
  $('.specification', row).value = item.specification || '';
  $('.specialty', row).value = item.specialty || '';
  $('.crm', row).value = item.crm || '';
  $('.justification', row).value = item.justification || '';
  $('.amount', row).value = item.amount === undefined ? '0,00' : Number(item.amount).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  setJustificationMode(row);
  $('.suggestion-toggle', row).onclick = () => openJustificationModal($('.justification', row));
  $('.manual-justification-toggle', row).onclick = () => openManualJustificationModal($('.justification', row));
  $('.module', row).addEventListener('change', () => { $('.specification', row).value = ''; $('.specialty', row).value = ''; $('.crm', row).value = ''; $('.justification', row).value = ''; $('.amount', row).value = '0,00'; activeModule = $('.module', row).value; $('#add-module').value = activeModule; setJustificationMode(row); showAll = false; renderFlow(); loadSpecifications(activeModule); totals(); persistDraft(); });
  $('.remove', row).addEventListener('click', () => { row.remove(); totals(); renderFlow(); persistDraft(); });
  row.addEventListener('input', () => { totals(); persistDraft(); });
  bindMoneyInput($('.amount', row));
  $('#items').append(row); renderFlow(); totals(); return row;
}
function renderFlow() {
  const honor = isHonor(activeModule); const index = modules.indexOf(activeModule);
  $('#module-name').textContent = activeModule; $('#module-step').textContent = `Etapa ${index + 1} de ${modules.length}`;
  $('#previous-module').disabled = index === 0; $('#next-module').disabled = index === modules.length - 1;
  $('#show-all').textContent = showAll ? 'Mostrar módulo atual' : 'Ver concluídos';
  rows().forEach((row) => { const rowHonor = isHonor($('.module', row).value); row.toggleAttribute('hidden', !showAll && $('.module', row).value !== activeModule); row.querySelectorAll('.honor-cell').forEach((cell) => { cell.toggleAttribute('hidden', !rowHonor && !showAll); cell.querySelector('input').toggleAttribute('hidden', !rowHonor); }); });
  document.querySelectorAll('.honor-column').forEach((cell) => cell.toggleAttribute('hidden', !honor && !showAll));
}
function activateModule(module) {
  activeModule = module; showAll = false;
  $('#add-module').value = module;
  if (!rows().some((row) => $('.module', row).value === module)) addItem(module); else renderFlow();
  loadSpecifications(module); persistDraft();
}
function totals() {
  const data = rows().map(rowValues); const billed = amount($('#billed').value); const glosa = data.filter((item) => item.module.startsWith('Glosa')).reduce((sum, item) => sum + item.amount, 0); const ajuste = data.filter((item) => item.module.startsWith('Ajuste')).reduce((sum, item) => sum + item.amount, 0);
  $('#billed-total').textContent = format(billed); $('#glosa-total').textContent = format(glosa); $('#ajuste-total').textContent = format(ajuste); $('#auditado-total').textContent = format(billed - glosa + ajuste);
}
function previewSections(items, prefix, title) {
  const sections = modules.filter((module) => module.startsWith(prefix)).map((module) => {
    const group = items.filter((item) => item.module === module); if (!group.length) return '';
    const label = module === 'Ajuste de honorários' ? 'Honorários - Ajuste' : module.toUpperCase(); const total = group.reduce((sum, item) => sum + item.amount, 0);
    return `<h3>${escape(label)}</h3><table><thead><tr><th>Item</th><th>Especificação</th><th>Justificativa</th><th>${prefix}</th></tr></thead><tbody>${group.map((item, index) => { const details = [item.specification, isHonor(module) && item.specialty, isHonor(module) && item.crm ? `CRM: ${item.crm}` : ''].filter(Boolean).join(' - '); return `<tr><td>${index + 1}</td><td>${escape(details)}</td><td>${escape(item.justification)}</td><td class="money">${format(item.amount)}</td></tr>`; }).join('')}<tr class="total"><th colspan="3">Total de ${escape(label)}</th><th class="money">${format(total)}</th></tr></tbody></table>`;
  }).join('');
  return sections ? `<h2>${title}</h2>${sections}` : '';
}
function preview(items, billed, glosa, ajuste) {
  $('#preview').innerHTML = `<article class="document-model"><div class="official"><img class="official-logo" src="/template-logo.png" alt="Exército Brasileiro">MINISTÉRIO DA DEFESA<br>EXÉRCITO BRASILEIRO<br>CMDO 15ª BDA INF MEC</div><p class="identity">OCS: ${escape($('#ocs').value)}<br>PACIENTE: ${escape($('#patient').value)}<br>GUIA Nº: ${escape($('#guide-number').value)}</p><table class="summary"><thead><tr><th>Valor<br>Apresentado</th><th>Glosa</th><th>Ajuste</th><th>Valor<br>Auditado</th><th>Observação</th></tr></thead><tbody><tr><td class="money">${format(billed)}</td><td class="money">${format(glosa)}</td><td class="money">${format(ajuste)}</td><td class="money">${format(billed - glosa + ajuste)}</td><td class="observation">Com relação às glosas e possíveis recursos, favor cumprir rigorosamente os prazos e procedimentos previstos nas cláusulas 7.1.21 até a cláusula 7.1.31 do Termo de Contrato celebrado entre as partes.</td></tr></tbody></table>${previewSections(items, 'Ajuste', 'RELATÓRIO DE AJUSTE')}${previewSections(items, 'Glosa', 'RELATÓRIO DE GLOSA')}<p style="margin-top:26px">Quartel em Cascavel-PR, ${new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })}</p><div class="signatures"><div>Médico Auditor da Seção de Auditoria de Contas Médicas</div><div>Enfermeira Auditora da Seção de Auditoria de Contas Médicas</div></div><footer class="report-footer"><span>(Relatório de Glosas do Atendimento ${escape($('#attendance-number').value || '________________')}</span><span class="leader"></span><span class="report-pages">1/1</span><span>)</span></footer></article>`;
}
function renderPreview() { const items = rows().map(rowValues), billed = amount($('#billed').value), glosa = items.filter((item) => item.module.startsWith('Glosa')).reduce((sum, item) => sum + item.amount, 0), ajuste = items.filter((item) => item.module.startsWith('Ajuste')).reduce((sum, item) => sum + item.amount, 0); preview(items, billed, glosa, ajuste); }
function renderEditHistory(entries = []) { const target = $('#edit-history'); target.replaceChildren(); if (!entries.length) return target.append(Object.assign(document.createElement('li'), { className: 'muted', textContent: 'Salve a guia para registrar o histórico.' })); entries.forEach((entry) => { const item = document.createElement('li'); const action = document.createElement('strong'); const meta = document.createElement('span'); action.textContent = entry.action; meta.textContent = `${entry.username} · ${dateTime(entry.created_at)}`; item.append(action, meta); const details = Array.isArray(entry.details) ? entry.details : []; if (details.length) { const list = Object.assign(document.createElement('ul'), { className: 'history-details' }); list.replaceChildren(...details.map((detail) => Object.assign(document.createElement('li'), { textContent: detail }))); item.append(list); } target.append(item); }); }
async function loadEditHistory(number = $('#guide-number').value) { if (!number) return renderEditHistory(); try { renderEditHistory(await api(`/api/guides/${number}/history`)); } catch { $('#edit-history').replaceChildren(Object.assign(document.createElement('li'), { className: 'muted', textContent: 'Histórico indisponível no momento.' })); } }
function persistDraft() { clearTimeout(draftTimer); draftTimer = setTimeout(() => sessionStorage.setItem(draftKey, JSON.stringify({ ocs: $('#ocs').value, patient: $('#patient').value, attendanceNumber: $('#attendance-number').value, billed: $('#billed').value, activeModule, items: rows().map(rowValues) })), 250); }
function restoreDraft() {
  try { const draft = JSON.parse(sessionStorage.getItem(draftKey)); if (!draft?.items?.length) return; $('#ocs').value = draft.ocs || ''; $('#patient').value = draft.patient || ''; $('#attendance-number').value = draft.attendanceNumber || ''; $('#billed').value = draft.billed || '0,00'; $('#items').replaceChildren(); activeModule = modules.includes(draft.activeModule) ? draft.activeModule : modules[0]; draft.items.forEach((item) => addItem(item.module, item)); } catch { sessionStorage.removeItem(draftKey); }
}
async function loadOcs() { [ocsOptions, patientOptions] = await Promise.all([api('/api/options/ocs'), api('/api/options/patients')]); }
async function loadSpecifications(module) { specificationOptions = await api(`/api/options/specifications?module=${encodeURIComponent(module)}`); }
async function loadModules() { modules = await api('/api/options/modules'); refreshModuleOptions(); renderFlow(); }
async function loadJustifications() { justificationOptions = await api('/api/options/justifications'); if (!$('#justification-modal').hidden) renderSavedJustifications($('#saved-justification-search').value); }
function setGuideEditable(editable, editableUntil = null) { currentGuideEditable = editable; $('#guide-form').querySelectorAll('input, select, textarea, button').forEach((field) => { field.disabled = !editable; }); $('#save-guide').disabled = !editable; $('#finalize-guide').disabled = !editable; const notice = $('#guide-lock-notice'); notice.hidden = editable; if (!editable) notice.textContent = `O prazo de edição terminou em ${dateTime(editableUntil)}. Esta guia continua disponível para consulta e impressão.`; }
function resetGuide(clearDraft = false) { if (clearDraft) sessionStorage.removeItem(draftKey); $('#guide-form').reset(); $('#guide-number').value = ''; $('#items').replaceChildren(); activeModule = modules[0]; currentGuideStatus = 'RASCUNHO'; showAll = false; addItem(); setGuideEditable(true); $('#print-guide').disabled = true; $('#billed').value = '0,00'; totals(); renderEditHistory(); navigate('guide', false); }
async function saveGuide(status = currentGuideStatus) {
  const items = rows().map(rowValues); const saved = await api('/api/guides', { method: 'POST', body: JSON.stringify({ number: $('#guide-number').value || 0, ocs: $('#ocs').value, patient: $('#patient').value, attendanceNumber: $('#attendance-number').value, billed: amount($('#billed').value), items, status }) });
  currentGuideStatus = saved.status; $('#guide-number').value = saved.number; $('#print-guide').disabled = saved.status !== 'FINALIZADA'; setGuideEditable(saved.editable, saved.editable_until); sessionStorage.removeItem(draftKey); toast(status === 'FINALIZADA' ? 'Guia finalizada com sucesso.' : 'Rascunho salvo com sucesso.', 'success'); loadOcs(); loadModules(); loadJustifications(); loadRecent(); await loadEditHistory(saved.number); return saved;
}
async function finalizeGuide() { if (!await confirmAction('A guia será finalizada e aberta para impressão.', { title: 'Finalizar guia', confirm: 'Finalizar' })) return; const report = window.open('', '_blank'); try { const saved = await saveGuide('FINALIZADA'); if (report) report.location = `/api/guides/${saved.number}/report`; } catch (error) { report?.close(); throw error; } }
function statusBadge(status) { return `<span class="guide-status ${status === 'FINALIZADA' ? 'finalized' : 'draft'}">${status === 'FINALIZADA' ? 'Finalizada' : 'Rascunho'}</span>`; }
function editWindow(guide) { if (guide.status !== 'FINALIZADA') return '<span class="edit-window open">Rascunho</span>'; if (!guide.editable_until) return '<span class="edit-window open">Disponível</span>'; const end = new Date(guide.editable_until), today = new Date(), remaining = Math.max(0, Math.round((Date.UTC(end.getFullYear(), end.getMonth(), end.getDate()) - Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000)); return `<span class="edit-window ${guide.editable ? 'open' : 'closed'}">${guide.editable ? `${remaining} ${remaining === 1 ? 'dia' : 'dias'}<small>até ${dateTime(guide.editable_until)}</small>` : 'Encerrada'}</span>`; }
async function loadDashboard() { const data = await api('/api/dashboard'); $('#dashboard-total').textContent = data.total; $('#dashboard-open').textContent = data.open; $('#dashboard-finalized').textContent = data.finalized; const target = $('#dashboard-guides'); target.replaceChildren(); if (!data.recent.length) return emptyRow(target, 7, 'Nenhuma guia registrada. Crie uma guia para iniciar a auditoria.'); data.recent.forEach((guide) => { const row = document.createElement('tr'); row.innerHTML = `<td>${guide.number}</td><td>${escape(guide.ocs || '—')}</td><td>${escape(guide.patient || '—')}</td><td>${statusBadge(guide.status)}</td><td>${dateTime(guide.finalized_at)}</td><td>${editWindow(guide)}</td><td class="row-actions"><a class="text-button open" href="/guias?guia=${guide.number}">Abrir</a></td>`; target.append(row); }); }
async function loadRecent() {
  const guides = await api(`/api/guides${guideFilter ? `?status=${guideFilter}` : ''}`); const target = $('#recent-guides'); target.replaceChildren(); $('#recent-description').textContent = guideFilter ? 'Guias em aberto: continue a edição ou finalize quando estiver pronta.' : 'Abra, imprima ou exclua uma guia.';
  if (!guides.length) return emptyRow(target, 7, guideFilter ? 'Não há guias em aberto.' : 'Nenhuma guia salva foi encontrada.');
  guides.forEach((guide) => { const row = document.createElement('tr'); row.innerHTML = `<td>${escape(guide.ocs || '—')}</td><td>${escape(guide.patient || '—')}</td><td>${format(guide.billed)}</td><td>${statusBadge(guide.status)}</td><td>${dateTime(guide.finalized_at)}</td><td>${editWindow(guide)}</td><td class="row-actions"><a class="text-button open" href="/guias?guia=${guide.number}">${guide.editable ? 'Editar' : 'Consultar'}</a>${guide.status === 'FINALIZADA' ? `<button type="button" class="text-button report" data-guide-number="${guide.number}">PDF</button>` : ''}<button type="button" class="text-button delete danger-text">Excluir</button></td>`; if (guide.status === 'FINALIZADA') $('.report', row).onclick = () => window.open(`/api/guides/${guide.number}/report`, '_blank'); $('.delete', row).onclick = async () => { if (!await confirmAction('Esta guia e seus itens serão removidos.', { title: 'Excluir guia', confirm: 'Excluir', danger: true })) return; try { await api(`/api/guides/${guide.number}`, { method: 'DELETE' }); toast('Guia excluída.', 'success'); loadRecent(); loadDashboard(); } catch (error) { toast(error.message, 'error'); } }; target.append(row); });
}
async function loadUsers() {
  const users = await api('/api/users'); const target = $('#users'); target.replaceChildren();
  const pending = users.filter((user) => Number(user.must_change_password)).length;
  $('#user-count-chip').innerHTML = `<strong>${users.length}</strong> ${users.length === 1 ? 'usuário' : 'usuários'}`;
  $('#pending-chip').hidden = !pending; $('#pending-chip').innerHTML = `<strong>${pending}</strong> ${pending === 1 ? 'aguarda' : 'aguardam'} troca de senha`;
  if (!users.length) return emptyRow(target, 4, 'Nenhum usuário cadastrado.');
  users.forEach((user) => { const row = document.createElement('tr'); const awaiting = Number(user.must_change_password); const removable = user.role !== 'admin'; row.innerHTML = `<td><strong>${escape(user.username)}</strong></td><td><span class="role-badge">${user.role === 'admin' ? 'Administrador' : 'Usuário'}</span></td><td><span class="status-badge ${awaiting ? 'pending' : 'ready'}">${awaiting ? 'Troca obrigatória' : 'Regular'}</span></td><td class="end"><div class="row-actions"><button class="text-button reset-user">Redefinir senha</button>${removable ? '<button class="text-button delete-user danger-text">Remover</button>' : ''}</div></td>`; $('.reset-user', row).onclick = async () => { if (!await confirmAction(`Uma senha temporária forte será gerada para ${user.username}.`, { title: 'Redefinir senha', confirm: 'Redefinir', danger: true })) return; const result = await api(`/api/users/${user.id}/reset-password`, { method: 'POST' }); toast(`Senha temporária de ${user.username}: ${result.temporaryPassword}`, 'success'); loadUsers(); }; if (removable) $('.delete-user', row).onclick = async () => { if (!await confirmAction(`Remover o usuário ${user.username}? Esta ação não pode ser desfeita.`, { title: 'Remover usuário', confirm: 'Remover', danger: true })) return; await api(`/api/users/${user.id}`, { method: 'DELETE' }); toast(`Usuário ${user.username} removido.`, 'success'); loadUsers(); }; target.append(row); });
}
async function loadUpdates() {
  const [system, history] = await Promise.all([api('/api/admin/system'), api('/api/admin/updates')]);
  $('#update-version').textContent = `v${system.version}`; $('#app-version').textContent = `v${system.version}`;
  const target = $('#update-history'); target.replaceChildren();
  if (!history.length) return emptyRow(target, 6, 'Nenhuma atualização aplicada.');
  const kinds = { corretiva: 'Corretiva', evolutiva: 'Evolutiva', seguranca: 'Segurança' };
  history.forEach((entry) => { let files = []; try { files = JSON.parse(entry.files); } catch {} const row = document.createElement('tr'); row.innerHTML = `<td><strong>v${escape(entry.version)}</strong><br><small class="muted">${escape(entry.filename)}</small></td><td>${escape(kinds[entry.kind] || entry.kind)}</td><td>${escape(entry.message || '—')}</td><td>${escape(entry.applied_by)}</td><td>${files.map((file) => `<code>${escape(file)}</code>`).join(' ')}</td><td>${dateTime(entry.created_at)}</td>`; target.append(row); });
}
function duration(seconds) { const days = Math.floor(seconds / 86400), hours = Math.floor(seconds % 86400 / 3600), minutes = Math.floor(seconds % 3600 / 60); return days ? `${days} d ${hours} h` : hours ? `${hours} h ${minutes} min` : `${Math.max(1, minutes)} min`; }
function setHealth(online, detail) { $('#health-status').textContent = online ? 'Online' : 'Indisponível'; $('#health-chip').className = `chip ${online ? 'ok' : 'bad'}`; $('#health-detail').textContent = detail; }
async function loadDeveloper() {
  try { const health = await api('/health'); setHealth(health.status === 'ok', health.status === 'ok' ? 'O serviço está respondendo normalmente.' : 'Verifique o serviço.'); } catch { setHealth(false, 'Não foi possível consultar o serviço.'); }
  try { const system = await api('/api/admin/system'); $('#ops-version').textContent = `v${system.version}`; $('#app-version').textContent = `v${system.version}`; $('#ops-database').textContent = system.database; $('#ops-node').textContent = system.node; $('#ops-uptime').textContent = duration(system.uptime); $('#ops-updates').textContent = system.updates; } catch (error) { toast(error.message, 'error'); }
}
async function openGuide(number) {
  navigate('guide');
  try {
    const guide = await api(`/api/guides/${number}`); $('#guide-number').value = guide.number; $('#ocs').value = guide.ocs; $('#patient').value = guide.patient; $('#attendance-number').value = guide.attendance_number || ''; $('#billed').value = Number(guide.billed).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); $('#items').replaceChildren(); currentGuideStatus = guide.status; activeModule = guide.items[0]?.module || modules[0]; showAll = false; guide.items.forEach((item) => addItem(item.module, item)); if (!guide.items.length) addItem(); refreshModuleOptions(); $('#add-module').value = activeModule; $('#print-guide').disabled = guide.status !== 'FINALIZADA'; setGuideEditable(guide.editable, guide.editable_until); totals(); await loadEditHistory(guide.number);
  } catch (error) {
    toast(error.message || 'Não foi possível abrir esta guia.', 'error');
    navigate('recent');
  }
}
function navigate(screen, push = true) { if (['admin', 'developer'].includes(screen) && currentSession?.role !== 'admin') return; if (['dashboard', 'guide', 'recent'].includes(screen) && currentSession?.role === 'admin') return; if (push && routes[screen] !== location.pathname) history.pushState(null, '', routes[screen]); document.querySelectorAll('.screen').forEach((item) => { item.hidden = item.id !== `${screen}-screen`; }); document.querySelectorAll('.nav-link').forEach((item) => item.classList.toggle('active', item.dataset.screen === screen)); if (screen === 'dashboard') loadDashboard().catch((error) => toast(error.message, 'error')); if (screen === 'recent') loadRecent().catch((error) => toast(error.message, 'error')); if (screen === 'admin') Promise.all([loadUsers(), loadUpdates()]).catch((error) => toast(error.message, 'error')); if (screen === 'developer') loadDeveloper(); }

$('#login-form').addEventListener('submit', async (event) => { event.preventDefault(); $('#login-error').hidden = true; try { const form = new FormData(event.currentTarget); const session = await api('/api/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(form)) }); if (session.mustChangePassword) { currentSession = session; showPasswordView(); } else showApp(session); } catch (error) { $('#login-error').textContent = error.message; $('#login-error').hidden = false; } });
$('#password-form').addEventListener('submit', async (event) => { event.preventDefault(); $('#password-error').hidden = true; try { const form = new FormData(event.currentTarget); const session = await api('/api/password', { method: 'POST', body: JSON.stringify(Object.fromEntries(form)) }); showApp(session); toast('Senha atualizada com sucesso.', 'success'); } catch (error) { $('#password-error').textContent = error.message; $('#password-error').hidden = false; } });
$('#logout').onclick = async () => { await api('/api/logout', { method: 'POST' }); showLogin(); };
setTheme(localStorage.getItem(themeKey) || 'light');
$('#theme-toggle').onclick = () => { const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; localStorage.setItem(themeKey, theme); setTheme(theme); };
document.querySelectorAll('.nav-link').forEach((button) => { button.onclick = () => { if (button.dataset.screen === 'recent') guideFilter = ''; navigate(button.dataset.screen); }; });
$('#dashboard-new-guide').onclick = () => { resetGuide(true); navigate('guide'); };
$('#dashboard-open-guides').onclick = () => { guideFilter = 'RASCUNHO'; navigate('recent'); };
$('#add-module').innerHTML = moduleOptions(activeModule);
$('#add-item').onclick = openItemModal;
document.querySelectorAll('.item-mode').forEach((button) => { button.onclick = () => setItemMode(button.dataset.mode); });
$('#item-modal-close').onclick = $('#item-modal-cancel').onclick = closeItemModal;
$('#item-modal').onclick = (event) => { if (event.target === $('#item-modal')) closeItemModal(); };
addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('#item-modal').hidden) closeItemModal(); });
$('#item-form').onsubmit = (event) => { event.preventDefault(); const custom = !$('#custom-module-fields').hidden; const name = $('#custom-module-name').value.trim().replace(/\s+/g, ' '); if (custom && !name) { toast('Informe o nome do novo módulo.', 'error'); $('#custom-module-name').focus(); return; } const module = custom ? `${$('#custom-module-type').value}: ${name}` : $('#add-module').value; if (!modules.includes(module)) modules.push(module); activeModule = module; refreshModuleOptions(); $('#add-module').value = module; $('#custom-module-name').value = ''; closeItemModal(); const row = addItem(module); persistDraft(); $('.specification', row).focus(); };
$('#justification-modal-close').onclick = $('#justification-modal-cancel').onclick = closeJustificationModal;
$('#justification-modal').onclick = (event) => { if (event.target === $('#justification-modal')) closeJustificationModal(); };
$('#saved-justification-search').oninput = (event) => renderSavedJustifications(event.target.value);
$('#add-saved-justification').onclick = async () => { const field = $('#new-saved-justification'); const value = field.value.trim(); if (!value) return toast('Digite uma justificativa antes de adicioná-la.', 'error'); if (await saveJustification(value)) { field.value = ''; renderSavedJustifications($('#saved-justification-search').value); field.focus(); } };
$('#saved-adjustment-value').oninput = (event) => { event.target.value = cents(event.target.value); };
$('#apply-adjustment-justification').onclick = () => { const row = justificationTarget?.closest('tr'); if (!row) return; $('.adjustment-value', row).value = $('#saved-adjustment-value').value; justificationTarget.value = ''; closeJustificationModal(); totals(); persistDraft(); };
$('#manual-justification-modal-close').onclick = $('#manual-justification-modal-cancel').onclick = closeManualJustificationModal;
$('#manual-justification-modal').onclick = (event) => { if (event.target === $('#manual-justification-modal')) closeManualJustificationModal(); };
$('#manual-justification-form').onsubmit = (event) => { event.preventDefault(); if (!manualJustificationTarget) return; manualJustificationTarget.value = $('#manual-justification-text').value.trim(); closeManualJustificationModal(); totals(); persistDraft(); };
addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('#justification-modal').hidden) closeJustificationModal(); if (event.key === 'Escape' && !$('#manual-justification-modal').hidden) closeManualJustificationModal(); if (event.key === 'Escape' && !$('#preview-modal').hidden) $('#preview-modal-close').click(); });
$('#new-guide').onclick = () => window.open('/guias', '_blank');
$('#guide-form').addEventListener('submit', (event) => { event.preventDefault(); saveGuide().catch((error) => toast(error.message, 'error')); });
$('#save-guide').onclick = () => saveGuide().catch((error) => toast(error.message, 'error'));
$('#finalize-guide').onclick = () => finalizeGuide().catch((error) => toast(error.message, 'error'));
$('#print-guide').onclick = () => window.open(`/api/guides/${$('#guide-number').value}/report`, '_blank');
$('#preview-guide').onclick = () => { renderPreview(); $('#preview-modal').hidden = false; $('#preview-modal-close').focus(); };
$('#preview-modal-close').onclick = () => { $('#preview-modal').hidden = true; $('#preview-guide').focus(); };
$('#preview-modal').onclick = (event) => { if (event.target === $('#preview-modal')) $('#preview-modal-close').click(); };
['ocs', 'patient', 'attendance-number'].forEach((id) => $("#" + id).addEventListener('input', () => { totals(); persistDraft(); })); bindMoneyInput($('#billed'));
bindSuggestions($('#ocs'), () => ocsOptions);
bindSuggestions($('#patient'), () => patientOptions);
$('#previous-module').onclick = () => activateModule(modules[Math.max(0, modules.indexOf(activeModule) - 1)]);
$('#next-module').onclick = () => activateModule(modules[Math.min(modules.length - 1, modules.indexOf(activeModule) + 1)]);
$('#show-all').onclick = () => { showAll = !showAll; renderFlow(); };

$('#new-user-form').addEventListener('submit', async (event) => { event.preventDefault(); const formElement = event.currentTarget; const button = $('button', formElement); if (button.disabled) return; button.disabled = true; try { const form = new FormData(formElement); const user = await api('/api/users', { method: 'POST', body: JSON.stringify(Object.fromEntries(form)) }); formElement.reset(); toast(`Usuário ${user.username} criado. Senha temporária: ${user.temporaryPassword}.`, 'success'); await loadUsers(); } catch (error) { if (error.message === 'Esse usuário já existe.') await loadUsers(); toast(error.message, 'error'); } finally { button.disabled = false; } });
const showFileName = () => { $('#update-file-name').textContent = $('#update-file').files[0]?.name || 'Nenhum arquivo selecionado'; };
$('#update-file').addEventListener('change', showFileName); $('#update-form').addEventListener('reset', () => setTimeout(showFileName));
$('#update-form').addEventListener('submit', async (event) => { event.preventDefault(); const form = event.currentTarget, file = $('#update-file').files[0], button = $('button', form); if (!file) return toast('Selecione um pacote ZIP.', 'error'); if (!await confirmAction(`Aplicar o pacote ${file.name}? Os arquivos autorizados serão substituídos após validação.`, { title: 'Aplicar atualização', confirm: 'Aplicar' })) return; button.disabled = true; $('#update-status').className = 'update-note'; $('#update-status').textContent = 'Validando e aplicando o pacote…'; try { const result = await api('/api/admin/updates', { method: 'POST', headers: { 'Content-Type': 'application/zip', 'X-Update-Filename': encodeURIComponent(file.name) }, body: file }); form.reset(); $('#update-status').className = 'update-note ok'; $('#update-status').textContent = `Versão ${result.version} aplicada (${result.message}): ${result.files.join(', ')}. Cópia de segurança em ${result.backup}.${result.restartRequired ? ' Reinicie o serviço para carregar a atualização do servidor.' : ' Recarregue a página para usar a nova interface.'}`; toast(`Atualização ${result.version} aplicada.`, 'success'); await loadUpdates(); } catch (error) { $('#update-status').className = 'update-note bad'; $('#update-status').textContent = error.message; toast(error.message, 'error'); } finally { button.disabled = false; } });

addEventListener('popstate', () => currentSession && navigate(routeScreen[location.pathname] || (currentSession.role === 'admin' ? 'admin' : 'dashboard'), false));
api('/api/session').then((session) => session?.username ? (session.mustChangePassword ? showPasswordView() : showApp(session)) : showLogin()).catch(showLogin);
