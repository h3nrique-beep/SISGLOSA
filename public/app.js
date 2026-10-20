let modules = ['Ajuste de honorários', 'Ajuste de exame laboratorial', 'Ajuste de exame de imagem', 'Glosa de honorário médico', 'Glosa de taxa', 'Glosa de material', 'Glosa de medicamento', 'Glosa de exame de imagem', 'Glosa de exame laboratorial', 'Glosa de nutrição', 'Glosa de OPME', 'Glosa de fisioterapia'];
const $ = (selector, root = document) => root.querySelector(selector);
const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const DEFAULT_ADJUSTMENT_JUSTIFICATION = 'Ajuste, será pago R$ conforme as regras da CBHPM Edição 2014 e de acordo com o item 5 do referencial de custos do contrato.';
const BASE_MODULES = [...modules];
let savedModules = [];
let activeModule = modules[0];
let showAll = false;
let draftTimer;
let currentSession;
let currentGuideStatus = 'RASCUNHO';
let currentGuideEditable = true;
let justificationOptions = [];
let ocsOptions = [], patientOptions = [], specificationOptions = [];
let justificationTarget;
let justificationModule = '';
let manualJustificationTarget;
// Nova chave: a antiga gravava o tema do sistema automaticamente e prenderia todos no escuro.
const themeKey = 'sisglosa-theme';
const routes = { dashboard: '/', guide: '/guias', recent: '/registros', admin: '/administracao', developer: '/desenvolvedor' };
const routeScreen = Object.fromEntries(Object.entries(routes).map(([screen, route]) => [route, screen]));

function isHonor(module) { return module.includes('honorário'); }
function hasSector(module) { return ['Glosa de material', 'Glosa de medicamento'].includes(module); }
function setTheme(theme) { document.documentElement.dataset.theme = theme; const label = theme === 'dark' ? 'Ativar modo claro' : 'Ativar modo escuro'; $('#theme-icon').className = `bi bi-${theme === 'dark' ? 'sun' : 'moon-stars'}`; $('#theme-toggle').setAttribute('aria-pressed', String(theme === 'dark')); $('#theme-toggle').setAttribute('aria-label', label); $('#theme-toggle').title = label; }
function isAdjustment(module) { return module.startsWith('Ajuste'); }
function amount(value) { return Number(String(value ?? '').replace(/[^0-9,-]/g, '').replace(/\./g, '').replace(',', '.')) || 0; }
function format(value) { return money.format(Number(value || 0)); }
function cents(value) { return (Number(String(value ?? '').replace(/\D/g, '')) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
// Mostra todas as sugestões que combinam (a lista rola); o x remove a sugestão no servidor, sem mexer nas guias.
function bindSuggestions(input, values, kind) { const menu = $('#custom-suggestions'); const show = () => { const matches = values().filter((value) => value.toLocaleLowerCase('pt-BR').includes(input.value.trim().toLocaleLowerCase('pt-BR'))); menu.replaceChildren(...matches.map((value) => { const row = document.createElement('div'); row.className = 'suggestion-row'; const option = Object.assign(document.createElement('button'), { type: 'button', className: 'suggestion-pick', textContent: value }); option.onmousedown = (event) => event.preventDefault(); option.onclick = () => { input.value = value; menu.hidden = true; input.dispatchEvent(new Event('input', { bubbles: true })); }; row.append(option); if (kind) { const remove = Object.assign(document.createElement('button'), { type: 'button', className: 'suggestion-remove', title: 'Remover sugestão', innerHTML: '<i class="bi bi-x-lg" aria-hidden="true"></i>' }); remove.setAttribute('aria-label', `Remover sugestão ${value}`); remove.onmousedown = (event) => event.preventDefault(); remove.onclick = async () => { try { await api(`/api/options/${kind}`, { method: 'DELETE', body: JSON.stringify({ value }) }); const list = values(); list.splice(list.indexOf(value), 1); show(); } catch (error) { toast(error.message, 'error'); } }; row.append(remove); } return row; })); if (!matches.length) return menu.hidden = true; const box = input.getBoundingClientRect(); Object.assign(menu.style, { left: `${box.left + scrollX}px`, top: `${box.bottom + scrollY + 5}px`, width: `${box.width}px` }); menu.hidden = false; }; input.addEventListener('focus', show); input.addEventListener('input', show); input.addEventListener('blur', () => setTimeout(() => { menu.hidden = true; }, 150)); }
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
const roleLabels = { user: 'Guias', admin: 'Administrador' }, roleIcons = { user: 'bi-file-earmark-text', admin: 'bi-shield-lock' };
function renderRoleSwitch(session) { const roles = session.roles || [session.role]; $('#role-switch').hidden = roles.length < 2; $('#role-switch').innerHTML = roles.map((role) => `<label title="Entrar como ${roleLabels[role]}"><input type="radio" name="active-role" value="${role}"${role === session.role ? ' checked' : ''}><span><i class="bi ${roleIcons[role]}" aria-hidden="true"></i>${roleLabels[role]}</span></label>`).join(''); }
function showApp(session) { currentSession = session; const admin = session.role === 'admin'; const screen = routeScreen[location.pathname]; const params = new URLSearchParams(location.search), requestedGuide = Number(params.get('guia')), freshGuide = params.has('nova') || requestedGuide > 0; $('#username').textContent = session.username; renderRoleSwitch(session); if (session.version) $('#app-version').textContent = `v${session.version}`; document.querySelectorAll('.admin-only').forEach((item) => { item.hidden = !admin; }); document.querySelectorAll('.guide-only').forEach((item) => { item.hidden = admin; }); $('#login-view').hidden = true; $('#login-view').style.display = 'none'; $('#password-view').hidden = true; $('#app-view').hidden = false; $('#app-view').style.display = 'flex'; document.body.classList.remove('loading'); if (admin) { api('/api/admin/monitor').then((data) => markDeveloperNav(data.health)).catch(() => {}); return navigate(screen === 'developer' ? 'developer' : 'admin', !['admin', 'developer'].includes(screen)); } resetGuide(); if (!freshGuide) restoreDraft(); totals(); loadOcs(); loadModules(); loadJustifications(); navigate(['dashboard', 'guide', 'recent'].includes(screen) ? screen : 'dashboard', !['dashboard', 'guide', 'recent'].includes(screen)); if (screen === 'guide' && Number.isInteger(requestedGuide) && requestedGuide > 0) openGuide(requestedGuide); }

function moduleOptions(selected) {
  return ['Ajuste', 'Glosa'].map((prefix) => `<optgroup label="${prefix}s">${modules.filter((module) => module.startsWith(prefix)).map((module) => `<option value="${escape(module)}" ${module === selected ? 'selected' : ''}>${escape(module)}</option>`).join('')}</optgroup>`).join('');
}
function refreshModuleOptions() { const selected = $('#add-module').value || activeModule; $('#add-module').innerHTML = moduleOptions(selected); if (modules.includes(selected)) $('#add-module').value = selected; rows().forEach((row) => { const current = $('.module', row).value; $('.module', row).innerHTML = moduleOptions(current); }); }
function setItemMode(mode) { const custom = mode === 'custom'; $('#existing-module-field').hidden = custom; $('#custom-module-fields').hidden = !custom; document.querySelectorAll('.item-mode').forEach((button) => { const selected = button.dataset.mode === mode; button.classList.toggle('active', selected); button.setAttribute('aria-selected', selected); }); $('#item-modal-submit').textContent = custom ? 'Criar e adicionar' : 'Adicionar item'; }
function closeItemModal() { $('#item-modal').hidden = true; }
function openItemModal() { setItemMode('existing'); $('#item-modal').hidden = false; $('#add-module').value = activeModule; $('#add-module').focus(); }
function applySavedJustification(value) { justificationTarget.value = value; closeJustificationModal(); totals(); persistDraft(); }
async function saveJustification(value) { const justification = value.trim(); if (!justification) { toast('Digite uma justificativa antes de salvá-la.', 'error'); return false; } try { await api('/api/options/justifications', { method: 'POST', body: JSON.stringify({ module: justificationModule, justification }) }); await loadJustifications(); toast('Justificativa salva para reutilização.', 'success'); return true; } catch (error) { toast(error.message, 'error'); return false; } }
async function deleteSavedJustification(value) { if (!await confirmAction('A justificativa será removida apenas da lista de sugestões. Guias e relatórios já registrados não serão alterados.', { title: 'Excluir justificativa salva', confirm: 'Excluir', danger: true })) return; try { await api('/api/options/justifications', { method: 'DELETE', body: JSON.stringify({ module: justificationModule, justification: value }) }); toast('Justificativa removida das sugestões.', 'success'); await loadJustifications(); } catch (error) { toast(error.message, 'error'); } }
function renderSavedJustifications(query = '') { const list = $('#saved-justification-list'); const values = justificationOptions.filter((value) => value.toLocaleLowerCase('pt-BR').includes(query.trim().toLocaleLowerCase('pt-BR'))); list.replaceChildren(); if (!values.length) return list.append(Object.assign(document.createElement('p'), { className: 'suggestion-empty', textContent: query ? 'Nenhuma justificativa encontrada.' : 'Ainda não há justificativas salvas.' })); values.forEach((value) => { const row = Object.assign(document.createElement('div'), { className: 'saved-justification' }); const option = Object.assign(document.createElement('button'), { type: 'button', className: 'suggestion-option', textContent: value }); option.onclick = () => applySavedJustification(value); row.append(option); if (value === DEFAULT_ADJUSTMENT_JUSTIFICATION) row.append(Object.assign(document.createElement('span'), { className: 'saved-justification-standard', textContent: 'Padrão' })); else { const remove = Object.assign(document.createElement('button'), { type: 'button', className: 'delete-saved-justification', textContent: 'Excluir', ariaLabel: 'Excluir justificativa salva' }); remove.onclick = () => deleteSavedJustification(value); row.append(remove); } list.append(row); }); }
function closeJustificationModal() { $('#justification-modal').hidden = true; $('#saved-adjustment-value-field').hidden = true; justificationTarget = null; }
function openJustificationModal(target) { justificationTarget = target; justificationModule = $('.module', target.closest('tr')).value; $('#justification-module').textContent = `Módulo: ${justificationModule}`; justificationOptions = []; $('#saved-justification-search').value = ''; $('#new-saved-justification').value = ''; $('#saved-adjustment-value-field').hidden = true; renderSavedJustifications(); loadJustifications().catch((error) => toast(error.message, 'error')); $('#justification-modal').hidden = false; $('#saved-justification-search').focus(); }
function closeManualJustificationModal() { $('#manual-justification-modal').hidden = true; manualJustificationTarget = null; }
function openManualJustificationModal(target) { manualJustificationTarget = target; $('#manual-justification-text').value = target.value; $('#manual-justification-modal').hidden = false; $('#manual-justification-text').focus(); }
function setJustificationMode(row) { $('.justification-composer', row).hidden = false; }
function rowValues(row) { return { module: $('.module', row).value, specification: $('.specification', row).value, specialty: $('.specialty', row).value, crm: $('.crm', row).value, sector: $('.sector', row).value, justification: $('.justification', row).value, amount: amount($('.amount', row).value) }; }
function rows() { return [...$('#items').rows]; }
function addItem(module = activeModule, item = {}) {
  if (!modules.includes(item.module || module)) modules.push(item.module || module);
  const row = $('#item-template').content.firstElementChild.cloneNode(true);
  $('.module', row).innerHTML = moduleOptions(item.module || module);
  bindSuggestions($('.specification', row), () => specificationOptions, 'specifications');
  $('.specification', row).value = item.specification || '';
  $('.specialty', row).value = item.specialty || '';
  $('.crm', row).value = item.crm || '';
  $('.sector', row).value = item.sector || '';
  $('.justification', row).value = item.justification || '';
  $('.amount', row).value = item.amount === undefined ? '0,00' : Number(item.amount).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  setJustificationMode(row);
  $('.suggestion-toggle', row).onclick = () => openJustificationModal($('.justification', row));
  $('.manual-justification-toggle', row).onclick = () => openManualJustificationModal($('.justification', row));
  $('.module', row).addEventListener('change', () => { $('.specification', row).value = ''; $('.specialty', row).value = ''; $('.crm', row).value = ''; $('.sector', row).value = ''; $('.justification', row).value = ''; $('.amount', row).value = '0,00'; activeModule = $('.module', row).value; pruneCustomModules(); $('#add-module').value = activeModule; setJustificationMode(row); showAll = false; renderFlow(); loadSpecifications(activeModule); totals(); persistDraft(); });
  $('.remove', row).addEventListener('click', () => { row.remove(); pruneCustomModules(); totals(); renderFlow(); persistDraft(); });
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
  rows().forEach((row) => { const rowSector = hasSector($('.module', row).value); const cell = $('.sector-cell', row); cell.toggleAttribute('hidden', !rowSector && !showAll); $('.sector', row).toggleAttribute('hidden', !rowSector); });
  document.querySelectorAll('.sector-column').forEach((cell) => cell.toggleAttribute('hidden', !hasSector(activeModule) && !showAll));
  renderModuleMap();
}
// Mapa dos módulos agrupado em Ajustes e Glosas, com a quantidade de itens lançados em cada um.
// Módulo criado na guia e sem nenhum item deixa de existir (os já salvos em outras guias continuam na lista).
function pruneCustomModules() {
  const used = new Set(rows().map((row) => $('.module', row).value));
  modules = modules.filter((module) => BASE_MODULES.includes(module) || savedModules.includes(module) || used.has(module));
  if (!used.has(activeModule) && !BASE_MODULES.includes(activeModule)) activeModule = modules[0];
  refreshModuleOptions();
}
function renderModuleMap() {
  const counts = {}; rows().forEach((row) => { const module = $('.module', row).value; counts[module] = (counts[module] || 0) + 1; });
  $('#module-map').innerHTML = ['Ajuste', 'Glosa'].map((prefix) => `<div class="module-map-group"><span class="module-map-label">${prefix}s</span>${modules.filter((module) => module.startsWith(prefix) && (BASE_MODULES.includes(module) || counts[module])).map((module) => `<button type="button" class="module-chip${module === activeModule ? ' active' : ''}${counts[module] ? ' filled' : ''}" data-module="${escape(module)}" aria-pressed="${module === activeModule}">${escape(module.replace(/^(Ajuste|Glosa)( de)?:?\s*/, '').replace(/^./, (letter) => letter.toUpperCase()))}${counts[module] ? `<span class="module-chip-count">${counts[module]}</span>` : ''}</button>`).join('')}</div>`).join('');
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
    return `<h3>${escape(label)}</h3><table><thead><tr><th>Item</th><th>Especificação</th><th>Justificativa</th><th>${prefix}</th></tr></thead><tbody>${group.map((item, index) => { const details = [item.specification, isHonor(module) && item.specialty, isHonor(module) && item.crm ? `CRM: ${item.crm}` : '', hasSector(module) && item.sector ? `Setor: ${item.sector}` : ''].filter(Boolean).join(' - '); return `<tr><td>${index + 1}</td><td>${escape(details)}</td><td>${escape(item.justification)}</td><td class="money">${format(item.amount)}</td></tr>`; }).join('')}<tr class="total"><th colspan="3">Total de ${escape(label)}</th><th class="money">${format(total)}</th></tr></tbody></table>`;
  }).join('');
  return sections ? `<h2>${title}</h2>${sections}` : '';
}
function preview(items, billed, glosa, ajuste) {
  $('#preview').innerHTML = `<article class="document-model"><div class="official"><img class="official-logo" src="/template-logo.png" alt="Exército Brasileiro">MINISTÉRIO DA DEFESA<br>EXÉRCITO BRASILEIRO<br>CMDO 15ª BDA INF MEC</div><p class="identity">OCS: ${escape($('#ocs').value)}<br>PACIENTE: ${escape($('#patient').value)}<br>GUIA Nº: ${escape($('#guide-code').value || $('#guide-number').value)}</p><table class="summary"><thead><tr><th>Valor<br>Apresentado</th><th>Glosa</th><th>Ajuste</th><th>Valor<br>Auditado</th><th>Observação</th></tr></thead><tbody><tr><td class="money">${format(billed)}</td><td class="money">${format(glosa)}</td><td class="money">${format(ajuste)}</td><td class="money">${format(billed - glosa + ajuste)}</td><td class="observation">Com relação às glosas e possíveis recursos, favor cumprir rigorosamente os prazos e procedimentos previstos nas cláusulas 7.1.21 até a cláusula 7.1.31 do Termo de Contrato celebrado entre as partes.</td></tr></tbody></table>${previewSections(items, 'Ajuste', 'RELATÓRIO DE AJUSTE')}${previewSections(items, 'Glosa', 'RELATÓRIO DE GLOSA')}<p style="margin-top:26px">Quartel em Cascavel-PR, ${new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })}</p><div class="signatures"><div>Médico Auditor da Seção de Auditoria de Contas Médicas</div><div>Enfermeira Auditora da Seção de Auditoria de Contas Médicas</div></div><footer class="report-footer"><span>(Relatório de Glosas do Atendimento ${escape($('#attendance-number').value || '________________')}</span><span class="leader"></span><span>)</span></footer></article>`;
}
function renderPreview() { const items = rows().map(rowValues), billed = amount($('#billed').value), glosa = items.filter((item) => item.module.startsWith('Glosa')).reduce((sum, item) => sum + item.amount, 0), ajuste = items.filter((item) => item.module.startsWith('Ajuste')).reduce((sum, item) => sum + item.amount, 0); preview(items, billed, glosa, ajuste); }
function renderEditHistory(entries = []) { const target = $('#edit-history'); target.replaceChildren(); if (!entries.length) return target.append(Object.assign(document.createElement('li'), { className: 'muted', textContent: 'Salve a guia para registrar o histórico.' })); entries.forEach((entry) => { const item = document.createElement('li'); const action = document.createElement('strong'); const meta = document.createElement('span'); action.textContent = entry.action; meta.textContent = `${entry.username} · ${dateTime(entry.created_at)}`; item.append(action, meta); const details = Array.isArray(entry.details) ? entry.details : []; if (details.length) { const list = Object.assign(document.createElement('ul'), { className: 'history-details' }); list.replaceChildren(...details.map((detail) => Object.assign(document.createElement('li'), { textContent: detail }))); item.append(list); } target.append(item); }); }
async function loadEditHistory(number = $('#guide-number').value) { if (!number) return renderEditHistory(); try { renderEditHistory(await api(`/api/guides/${number}/history`)); } catch { $('#edit-history').replaceChildren(Object.assign(document.createElement('li'), { className: 'muted', textContent: 'Histórico indisponível no momento.' })); } }
// Rascunho automático no servidor: sobrevive a fechar a aba e a trocar de máquina; some quando a guia é gravada.
function draftPayload() { return { number: $('#guide-number').value, guideCode: $('#guide-code').value, status: currentGuideStatus, ocs: $('#ocs').value, patient: $('#patient').value, attendanceNumber: $('#attendance-number').value, billed: $('#billed').value, activeModule, items: rows().map(rowValues) }; }
// Rascunho resistente a atualização: se o servidor estiver reiniciando, tenta de novo a cada 3 s; se a sessão cair,
// guarda no navegador e devolve ao servidor no próximo login do mesmo usuário (depois apaga a cópia local).
const draftStashKey = () => `sisglosa-rascunho:${currentSession?.username || ''}`;
const stash = { get: (key) => { try { return localStorage.getItem(key); } catch { return null; } }, set: (key, value) => { try { localStorage.setItem(key, value); } catch {} }, drop: (key) => { try { localStorage.removeItem(key); } catch {} } };
function persistDraft(delay = 800) { if (!currentGuideEditable) return; clearTimeout(draftTimer); draftTimer = setTimeout(sendDraft, delay); }
async function sendDraft() {
  if (!currentSession) return;
  const key = draftStashKey(), body = JSON.stringify(draftPayload());
  try { await api('/api/draft', { method: 'PUT', body }); stash.drop(key); } catch { stash.set(key, body); if (currentSession) draftTimer = setTimeout(sendDraft, 3000); }
}
function clearDraft() { clearTimeout(draftTimer); stash.drop(draftStashKey()); return api('/api/draft', { method: 'DELETE' }).catch(() => {}); }
async function restoreDraft() {
  try {
    const pending = stash.get(draftStashKey()); if (pending) { await api('/api/draft', { method: 'PUT', body: pending }); stash.drop(draftStashKey()); }
    const draft = await api('/api/draft'); if (!draft?.items?.length) return;
    $('#guide-number').value = draft.number || ''; currentGuideStatus = draft.status === 'FINALIZADA' ? 'FINALIZADA' : 'RASCUNHO';
    $('#guide-code').value = draft.guideCode || ''; $('#ocs').value = draft.ocs || ''; $('#patient').value = draft.patient || ''; $('#attendance-number').value = draft.attendanceNumber || ''; $('#billed').value = draft.billed || '0,00';
    $('#items').replaceChildren(); activeModule = modules.includes(draft.activeModule) ? draft.activeModule : modules[0]; draft.items.forEach((item) => addItem(item.module, item));
    $('#print-guide').disabled = !draft.number || currentGuideStatus !== 'FINALIZADA'; totals(); checkAttendance(); if (draft.number) loadEditHistory(draft.number);
    if (location.pathname === routes.guide) toast('Rascunho não gravado recuperado. Salve a guia para registrá-lo.', 'success');
  } catch {}
}
let attendanceTimer;
function checkAttendance() {
  clearTimeout(attendanceTimer);
  attendanceTimer = setTimeout(async () => {
    const number = $('#attendance-number').value.trim(), warning = $('#attendance-warning');
    if (!number) { warning.hidden = true; return; }
    try {
      const others = await api(`/api/guides/attendance?number=${encodeURIComponent(number)}&exclude=${encodeURIComponent($('#guide-number').value || 0)}`);
      warning.hidden = !others.length;
      warning.textContent = others.length ? `Atenção: este atendimento já está na${others.length > 1 ? 's' : ''} guia${others.length > 1 ? 's' : ''} nº ${others.map((guide) => guide.number).join(', ')}.` : '';
    } catch { warning.hidden = true; }
  }, 400);
}
async function loadOcs() { [ocsOptions, patientOptions] = await Promise.all([api('/api/options/ocs'), api('/api/options/patients')]); }
async function loadSpecifications(module) { specificationOptions = await api(`/api/options/specifications?module=${encodeURIComponent(module)}`); }
async function loadModules() { modules = await api('/api/options/modules'); savedModules = [...modules]; refreshModuleOptions(); renderFlow(); }
async function loadJustifications() { if (!justificationModule) return; justificationOptions = await api(`/api/options/justifications?module=${encodeURIComponent(justificationModule)}`); if (!$('#justification-modal').hidden) renderSavedJustifications($('#saved-justification-search').value); }
function setGuideEditable(editable, editableUntil = null) { currentGuideEditable = editable; $('#guide-form').querySelectorAll('input, select, textarea, button').forEach((field) => { field.disabled = !editable; }); $('#save-guide').disabled = !editable; $('#finalize-guide').disabled = !editable; const notice = $('#guide-lock-notice'); notice.hidden = editable; if (!editable) notice.textContent = `O prazo de edição terminou em ${dateTime(editableUntil)}. Esta guia continua disponível para consulta e impressão.`; }
function resetGuide(discardDraft = false) { if (discardDraft) clearDraft(); $('#guide-form').reset(); $('#guide-number').value = ''; $('#items').replaceChildren(); activeModule = modules[0]; currentGuideStatus = 'RASCUNHO'; showAll = false; addItem(); setGuideEditable(true); $('#print-guide').disabled = true; $('#billed').value = '0,00'; totals(); renderEditHistory(); $('#attendance-warning').hidden = true; navigate('guide', false); }
async function saveGuide(status = currentGuideStatus) {
  const items = rows().map(rowValues); const saved = await api('/api/guides', { method: 'POST', body: JSON.stringify({ number: $('#guide-number').value || 0, guideCode: $('#guide-code').value, ocs: $('#ocs').value, patient: $('#patient').value, attendanceNumber: $('#attendance-number').value, billed: amount($('#billed').value), items, status }) });
  currentGuideStatus = saved.status; $('#guide-number').value = saved.number; $('#print-guide').disabled = saved.status !== 'FINALIZADA'; setGuideEditable(saved.editable, saved.editable_until); clearTimeout(draftTimer); stash.drop(draftStashKey()); toast(status === 'FINALIZADA' ? 'Guia finalizada com sucesso.' : 'Rascunho salvo com sucesso.', 'success'); loadOcs(); loadModules(); loadJustifications(); await loadEditHistory(saved.number); return saved;
}
async function finalizeGuide() { if (!await confirmAction('A guia será finalizada e aberta para impressão.', { title: 'Finalizar guia', confirm: 'Finalizar' })) return; const report = window.open('', '_blank'); try { const saved = await saveGuide('FINALIZADA'); if (report) report.location = `/api/guides/${saved.number}/report`; } catch (error) { report?.close(); throw error; } }
function statusBadge(status) { return `<span class="guide-status ${status === 'FINALIZADA' ? 'finalized' : 'draft'}">${status === 'FINALIZADA' ? 'Finalizada' : 'Rascunho'}</span>`; }
function editWindow(guide) { if (guide.status !== 'FINALIZADA') return '<span class="edit-window open">Rascunho</span>'; if (!guide.editable_until) return '<span class="edit-window open">Disponível</span>'; const end = new Date(guide.editable_until), today = new Date(), remaining = Math.max(0, Math.round((Date.UTC(end.getFullYear(), end.getMonth(), end.getDate()) - Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000)); return `<span class="edit-window ${guide.editable ? 'open' : 'closed'}">${guide.editable ? `${remaining} ${remaining === 1 ? 'dia' : 'dias'}<small>até ${dateTime(guide.editable_until)}</small>` : 'Encerrada'}</span>`; }
function renderDashboardValues(data) {
  $('#dashboard-values-panel').hidden = !data.open; if (!data.open) return;
  $('#dashboard-values-count').textContent = `· ${data.open} ${data.open === 1 ? 'guia em aberto' : 'guias em aberto'}`;
  $('#dashboard-billed').textContent = format(data.billed); $('#dashboard-glosa').textContent = format(data.glosa); $('#dashboard-ajuste').textContent = format(data.ajuste); $('#dashboard-audited').textContent = format(data.billed - data.glosa + data.ajuste);
  $('#dashboard-glosa-rate').textContent = data.billed ? `${(data.glosa / data.billed * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% do valor apresentado` : 'Valor apresentado não informado';
}
async function loadDashboard() { const data = await api('/api/dashboard'); $('#dashboard-total').textContent = data.total; $('#dashboard-open').textContent = data.open; $('#dashboard-finalized').textContent = data.finalized; renderDashboardValues(data); const target = $('#dashboard-guides'); target.replaceChildren(); if (!data.recent.length) return emptyRow(target, 7, 'Nenhuma guia registrada. Crie uma guia para iniciar a auditoria.'); data.recent.forEach((guide) => { const row = document.createElement('tr'); row.innerHTML = `<td>${guide.number}</td><td>${escape(guide.ocs || '—')}</td><td>${escape(guide.patient || '—')}</td><td>${statusBadge(guide.status)}</td><td>${dateTime(guide.finalized_at)}</td><td>${editWindow(guide)}</td><td class="row-actions"><button type="button" class="text-button summary">Resumo</button><a class="text-button open" href="/guias?guia=${guide.number}">Abrir</a></td>`; $('.summary', row).onclick = () => showGuideSummary(guide.number).catch((error) => toast(error.message, 'error')); target.append(row); }); }
function recentQuery() { const params = new URLSearchParams(); new FormData($('#recent-filters')).forEach((value, key) => { if (String(value).trim()) params.set(key, String(value).trim()); }); return params.toString(); }
function guideSituation(guide) {
  if (guide.status !== 'FINALIZADA') return statusBadge(guide.status);
  return `${statusBadge(guide.status)}<small class="situation-note">${guide.editable ? `edição até ${new Date(guide.editable_until).toLocaleDateString('pt-BR')}` : 'somente consulta'}</small>`;
}
const iconButton = (name, icon, label, extra = '') => `<button type="button" class="icon-button ${name}${extra}" title="${label}" aria-label="${label}"><i class="bi bi-${icon}" aria-hidden="true"></i></button>`;
async function loadRecent() {
  const query = recentQuery();
  const guides = await api(`/api/guides${query ? `?${query}` : ''}`);
  const target = $('#recent-guides'); target.replaceChildren();
  if (!guides.length) return emptyRow(target, 7, query ? 'Nenhuma guia encontrada. Ajuste a busca ou clique em Limpar.' : 'Nenhuma guia salva ainda.');
  guides.forEach((guide) => {
    const row = document.createElement('tr');
    row.innerHTML = `<td>${guide.number}</td><td>${escape(guide.ocs || '—')}</td><td>${escape(guide.patient || '—')}</td><td>${escape(guide.attendance_number || '—')}</td><td class="money">${format(guide.billed)}</td><td class="situation">${guideSituation(guide)}</td><td class="row-actions"><a class="text-button open" href="/guias?guia=${guide.number}">${guide.editable ? 'Abrir' : 'Consultar'}</a>${iconButton('totals', 'bar-chart', 'Ver totais da guia')}${iconButton('duplicate', 'copy', 'Duplicar guia')}${guide.status === 'FINALIZADA' ? iconButton('report', 'printer', 'Imprimir / PDF') : ''}${guide.editable ? iconButton('delete', 'trash', 'Excluir guia', ' danger-text') : ''}</td>`;
    $('.totals', row).onclick = () => showGuideSummary(guide.number).catch((error) => toast(error.message, 'error'));
    $('.duplicate', row).onclick = () => duplicateGuide(guide.number).catch((error) => toast(error.message, 'error'));
    if (guide.status === 'FINALIZADA') $('.report', row).onclick = () => window.open(`/api/guides/${guide.number}/report`, '_blank');
    if (guide.editable) $('.delete', row).onclick = async () => { if (!await confirmAction(`A guia nº ${guide.number} e seus itens serão removidos.`, { title: 'Excluir guia', confirm: 'Excluir', danger: true })) return; try { await api(`/api/guides/${guide.number}`, { method: 'DELETE' }); toast('Guia excluída.', 'success'); loadRecent(); } catch (error) { toast(error.message, 'error'); } };
    target.append(row);
  });
}
// Nova guia a partir de outra: mesma OCS e mesmos itens; paciente, atendimento e valor apresentado ficam em branco.
async function duplicateGuide(number) {
  const source = await api(`/api/guides/${number}`);
  resetGuide(true); $('#ocs').value = source.ocs || '';
  $('#items').replaceChildren(); activeModule = source.items[0]?.module || modules[0]; source.items.forEach((item) => addItem(item.module, item)); if (!source.items.length) addItem();
  refreshModuleOptions(); totals(); navigate('guide'); persistDraft(); $('#patient').focus();
  toast(`Nova guia criada a partir da nº ${number}. Informe o paciente e salve.`, 'success');
}
async function loadUsers() {
  const users = await api('/api/users'); const target = $('#users'); target.replaceChildren();
  const pending = users.filter((user) => Number(user.must_change_password)).length;
  $('#user-count-chip').innerHTML = `<strong>${users.length}</strong> ${users.length === 1 ? 'usuário' : 'usuários'}`;
  $('#pending-chip').hidden = !pending; $('#pending-chip').innerHTML = `<strong>${pending}</strong> ${pending === 1 ? 'aguarda' : 'aguardam'} troca de senha`;
  if (!users.length) return emptyRow(target, 4, 'Nenhum usuário cadastrado.');
  users.forEach((user) => { const row = document.createElement('tr'); const awaiting = Number(user.must_change_password); const removable = !user.roles.includes('admin'); row.innerHTML = `<td><strong>${escape(user.username)}</strong></td><td><span class="role-choices inline">${Object.entries(roleLabels).map(([role, label]) => `<label class="role-chip"><input type="checkbox" class="user-role" value="${role}"${user.roles.includes(role) ? ' checked' : ''}><span><i class="bi ${roleIcons[role]}" aria-hidden="true"></i>${label}</span></label>`).join('')}</span></td><td><span class="status-badge ${awaiting ? 'pending' : 'ready'}">${awaiting ? 'Troca obrigatória' : 'Regular'}</span></td><td class="end"><div class="row-actions"><button class="text-button reset-user">Redefinir senha</button>${removable ? '<button class="text-button delete-user danger-text">Remover</button>' : ''}</div></td>`; row.querySelectorAll('.user-role').forEach((box) => { box.onchange = async () => { const roles = [...row.querySelectorAll('.user-role:checked')].map((item) => item.value); try { await api(`/api/users/${user.id}/roles`, { method: 'PUT', body: JSON.stringify({ roles }) }); toast(`Perfis de ${user.username} atualizados.`, 'success'); if (user.username === currentSession.username) { currentSession = await api('/api/session'); renderRoleSwitch(currentSession); } } catch (error) { toast(error.message, 'error'); } loadUsers(); }; }); $('.reset-user', row).onclick = async () => { if (!await confirmAction(`Uma senha temporária forte será gerada para ${user.username}.`, { title: 'Redefinir senha', confirm: 'Redefinir', danger: true })) return; const result = await api(`/api/users/${user.id}/reset-password`, { method: 'POST' }); toast(`Senha temporária de ${user.username}: ${result.temporaryPassword}`, 'success'); loadUsers(); }; if (removable) $('.delete-user', row).onclick = async () => { if (!await confirmAction(`Remover o usuário ${user.username}? Esta ação não pode ser desfeita.`, { title: 'Remover usuário', confirm: 'Remover', danger: true })) return; await api(`/api/users/${user.id}`, { method: 'DELETE' }); toast(`Usuário ${user.username} removido.`, 'success'); loadUsers(); }; target.append(row); });
}
const updateKinds = { corretiva: 'Corretiva', evolutiva: 'Evolutiva', seguranca: 'Segurança' };
let activeVersion = '';
// Corretiva avança x.y.Z; evolutiva avança x.Y.0.
function nextVersion(version, type) { const [major = 0, minor = 0, patch = 0] = String(version).split(/[-+]/)[0].split('.').map((part) => Number(part) || 0); return type === 'evolutiva' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`; }
function suggestVersion() { const input = $('#update-next-version'); if (!activeVersion || input.dataset.edited) return; input.value = nextVersion(activeVersion, $('#update-form').elements.type.value); $('#update-version-hint').textContent = `Usada só se o pacote não trouxer versão (sugerida a partir da v${activeVersion}).`; }
function renderUpdates(system, history) {
  activeVersion = system.version; $('#update-version').textContent = `v${system.version}`; $('#app-version').textContent = `v${system.version}`; $('#ops-updates').textContent = system.updates; suggestVersion();
  const last = history[0]; $('#ops-last-message').textContent = last?.message || 'Versão de instalação.'; $('#ops-last-kind').textContent = last ? updateKinds[last.kind] || last.kind : '—'; $('#ops-last-date').textContent = last ? dateTime(last.created_at) : 'Nenhum pacote aplicado.';
  const target = $('#update-history'); target.replaceChildren();
  if (!history.length) return emptyRow(target, 6, 'Nenhuma atualização aplicada.');
  history.forEach((entry) => { let files = []; try { files = JSON.parse(entry.files); } catch {} const row = document.createElement('tr'); row.innerHTML = `<td><strong>v${escape(entry.version)}</strong><br><small class="muted">${escape(entry.filename)}</small></td><td><span class="kind-badge ${escape(entry.kind)}">${escape(updateKinds[entry.kind] || entry.kind)}</span></td><td>${escape(entry.message || '—')}</td><td>${escape(entry.applied_by)}</td><td>${files.slice(0, 6).map((file) => `<code>${escape(file)}</code>`).join(' ')}${files.length > 6 ? ` <small class="muted">+${files.length - 6} arquivos</small>` : ''}</td><td>${dateTime(entry.created_at)}</td>`; target.append(row); });
}
function duration(seconds) { const days = Math.floor(seconds / 86400), hours = Math.floor(seconds % 86400 / 3600), minutes = Math.floor(seconds % 3600 / 60); return days ? `${days} d ${hours} h` : hours ? `${hours} h ${minutes} min` : `${Math.max(1, minutes)} min`; }
function setHealth(online, detail) { $('#health-status').textContent = online ? 'Online' : 'Indisponível'; $('#health-chip').className = `chip ${online ? 'ok' : 'bad'}`; $('#health-detail').textContent = detail; }
// Pede campos (senha, frase-senha, confirmação) num diálogo; resolve com os valores, ou null se cancelar.
function promptFields(title, message, fields, { confirm = 'Confirmar', danger = false } = {}) {
  return new Promise((resolve) => {
    const modal = $('#prompt-modal'), form = $('#prompt-form'), box = $('#prompt-fields');
    $('#prompt-title').textContent = title; $('#prompt-message').textContent = message; $('#prompt-confirm').textContent = confirm; $('#prompt-confirm').classList.toggle('danger', danger);
    box.replaceChildren(...fields.map((field) => { const label = document.createElement('label'); label.textContent = field.label; const input = Object.assign(document.createElement('input'), { name: field.name, type: field.type || 'text', required: true, autocomplete: field.autocomplete || 'off', placeholder: field.placeholder || '' }); if (field.minLength) input.minLength = field.minLength; label.append(input); return label; }));
    const close = (value) => { modal.hidden = true; form.onsubmit = $('#prompt-cancel').onclick = modal.onclick = null; document.removeEventListener('keydown', keydown); form.reset(); resolve(value); };
    const keydown = (event) => { if (event.key === 'Escape') close(null); };
    form.onsubmit = (event) => { event.preventDefault(); close(Object.fromEntries(new FormData(form))); };
    $('#prompt-cancel').onclick = () => close(null); modal.onclick = (event) => { if (event.target === modal) close(null); }; document.addEventListener('keydown', keydown);
    modal.hidden = false; $('input', box)?.focus();
  });
}
const passwordField = { name: 'password', label: 'Sua senha', type: 'password', autocomplete: 'current-password' };
const msDate = (ms) => ms ? new Date(Number(ms)).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
const percent = (value) => value === null || value === undefined ? '—' : `${value.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
const fileSize = (bytes) => bytes >= 1048576 ? `${(bytes / 1048576).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const severityLabels = { CRITICO: 'Crítico', ALTO: 'Alto', MEDIO: 'Médio', INFO: 'Informativo' };
const healthLabels = { verde: ['ok', 'Tudo normal'], amarelo: ['warn', 'Atenção'], vermelho: ['bad', 'Problema crítico'] };
const backupKinds = { manual: 'Manual', auto: 'Automático', 'pre-update': 'Antes de atualização', 'pre-restore': 'Antes de restauração' };
const backupActions = { criado: 'gerado', baixado: 'baixado', restaurado: 'restaurado' };
// Ponto no menu Desenvolvedor quando há alerta aberto: o administrador vê sem abrir a tela.
function markDeveloperNav(health) { const tab = $('.dev-tab[data-tab="saude"]'); tab.classList.toggle('has-alert', health === 'amarelo'); tab.classList.toggle('has-critical', health === 'vermelho'); const link = $('.nav-link[data-screen="developer"]'); link.classList.toggle('has-alert', health === 'amarelo'); link.classList.toggle('has-critical', health === 'vermelho'); }
function sparkline(svg, values) {
  const points = values.filter((value) => value !== null && value !== undefined);
  if (points.length < 2) return svg.replaceChildren();
  const step = 100 / (points.length - 1);
  svg.innerHTML = `<polyline points="${points.map((value, index) => `${(index * step).toFixed(2)},${(23 - Math.min(100, value) / 100 * 22).toFixed(2)}`).join(' ')}"/>`;
}
function alertItem(alert, resolved = false) {
  const item = document.createElement('li'), severity = alert.severity.toLowerCase(); item.className = `alert-item ${severity}`;
  item.innerHTML = `<span class="severity-badge ${escape(severity)}">${escape(severityLabels[alert.severity] || alert.severity)}</span><div><strong>${escape(alert.title)}</strong>${!resolved && alert.detail ? `<p>${escape(alert.detail)}</p>` : ''}<small class="muted">${resolved ? `Aberto ${msDate(alert.opened_at)} · resolvido ${msDate(alert.resolved_at)}` : `Desde ${msDate(alert.opened_at)} · visto ${msDate(alert.seen_at)}`}</small></div>`;
  return item;
}
function renderMonitor(data) {
  const [tone, label] = healthLabels[data.health] || healthLabels.amarelo; $('#monitor-chip').className = `chip ${tone}`; $('#monitor-health').textContent = label; markDeveloperNav(data.health);
  const latest = data.latest || {};
  $('#monitor-disk').textContent = percent(latest.disk); $('#monitor-disk-card').className = latest.disk < 10 ? 'danger' : '';
  $('#monitor-ram').textContent = percent(latest.ram); $('#monitor-ram-card').className = latest.ram > 90 ? 'warning' : '';
  sparkline($('#monitor-disk-chart'), data.samples.map((sample) => sample.disk)); sparkline($('#monitor-ram-chart'), data.samples.map((sample) => sample.ram));
  $('#monitor-db').textContent = latest.dbKb === null || latest.dbKb === undefined ? '—' : fileSize(latest.dbKb * 1024);
  const changed = data.open.some((alert) => alert.alert_key === 'arquivos.alterados');
  $('#monitor-snapshot').textContent = changed ? 'Alterado' : 'Íntegro'; $('#monitor-snapshot').parentElement.className = changed ? 'danger' : 'success';
  $('#monitor-checked').textContent = `Referência de ${msDate(data.snapshotAt)}${data.snapshotBy ? ` (${data.snapshotBy})` : ''} · conferido ${msDate(data.checkedAt)}`;
  const list = $('#monitor-alerts'); list.replaceChildren(...data.open.map((alert) => alertItem(alert)));
  if (!data.open.length) list.innerHTML = '<li class="alert-empty"><i class="bi bi-check-circle" aria-hidden="true"></i> Nenhum alerta aberto.</li>';
  $('#monitor-resolved-wrap').hidden = !data.resolved.length; $('#monitor-resolved').replaceChildren(...data.resolved.map((alert) => alertItem(alert, true)));
}
async function loadMonitor() { renderMonitor(await api('/api/admin/monitor')); }
function renderBackups(data) {
  $('#backup-create').disabled = !data.enabled;
  const latest = data.backups[0], warning = !data.enabled ? 'Com MySQL/MariaDB, o backup é feito pelo script deploy/proxmox/backup-sisglosa.sh e não aparece aqui.' : !latest ? 'Nenhum backup gerado ainda.' : Date.now() - latest.created_at > 26 * 3600 * 1000 ? `O último backup é de ${msDate(latest.created_at)}: o automático deveria rodar a cada 24 h.` : '';
  $('#backup-warning').hidden = !warning; $('#backup-warning').textContent = warning;
  const target = $('#backup-list'); target.replaceChildren();
  if (!data.backups.length) emptyRow(target, 6, data.enabled ? 'Nenhum backup gerado ainda.' : 'Backups do MySQL ficam fora do painel.');
  data.backups.forEach((backup) => {
    const row = document.createElement('tr');
    row.innerHTML = `<td><strong>${msDate(backup.created_at)}</strong><br><small class="muted">${escape(backup.created_by || '—')}</small></td><td><span class="kind-badge ${escape(backup.kind)}">${escape(backupKinds[backup.kind] || backup.kind)}</span></td><td>${fileSize(backup.size)}</td><td>${backup.guides ?? '—'} ${backup.guides === 1 ? 'guia' : 'guias'} · ${backup.users ?? '—'} ${backup.users === 1 ? 'usuário' : 'usuários'}</td><td><span class="status-badge ${backup.ok ? 'ready' : 'pending'}" title="${escape(backup.integrity || '')}">${backup.ok ? 'Íntegro' : 'Falhou'}</span></td><td class="end"><div class="row-actions"><button class="text-button download-backup" type="button">Baixar</button>${backup.ok ? '<button class="text-button restore-backup danger-text" type="button">Restaurar</button>' : ''}</div></td>`;
    $('.download-backup', row).onclick = () => downloadBackup(backup.name).catch((error) => toast(error.message, 'error'));
    if (backup.ok) $('.restore-backup', row).onclick = () => restoreBackup(backup).catch((error) => toast(error.message, 'error'));
    target.append(row);
  });
  const history = $('#backup-history'); history.replaceChildren(...data.history.map((entry) => { const item = document.createElement('li'); item.textContent = `${msDate(entry.at)} — ${entry.name || ''} ${backupActions[entry.action] || entry.action} por ${entry.username}${entry.ip ? ` (${entry.ip})` : ''}${entry.ok === false ? ' — verificação falhou' : ''}`; return item; }));
  if (!data.history.length) history.innerHTML = '<li class="muted">Sem registros.</li>';
}
async function loadBackups() { renderBackups(await api('/api/admin/backups')); }
async function downloadBackup(name) {
  const values = await promptFields('Baixar backup', 'O arquivo sai cifrado com a frase-senha abaixo. Guarde-a: sem ela o arquivo não abre (node scripts/abrir-backup.js).', [passwordField, { name: 'passphrase', label: 'Frase-senha do arquivo (mínimo 8 caracteres)', type: 'password', minLength: 8, autocomplete: 'new-password' }], { confirm: 'Baixar' });
  if (!values) return;
  const response = await fetch('/api/admin/backups/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, ...values }) });
  if (response.status === 401) { showLogin(); throw new Error('Sessão expirada.'); }
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || 'Não foi possível baixar o backup.');
  const url = URL.createObjectURL(await response.blob()), link = Object.assign(document.createElement('a'), { href: url, download: `${name}.sgbk` });
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Backup baixado (cifrado).', 'success'); loadBackups().catch(() => {});
}
async function restoreBackup(backup) {
  const values = await promptFields('Restaurar backup', `O banco volta ao estado de ${msDate(backup.created_at)} (${backup.guides ?? '—'} guias). Tudo o que foi lançado depois será perdido, contas e senhas voltam às daquela data e todos os usuários serão desconectados. Antes, o banco atual é guardado como "Antes de restauração".`, [{ name: 'confirmation', label: 'Digite RESTAURAR para confirmar', placeholder: 'RESTAURAR' }, passwordField], { confirm: 'Restaurar', danger: true });
  if (!values) return;
  const result = await api('/api/admin/backups/restore', { method: 'POST', body: JSON.stringify({ name: backup.name, ...values }) });
  toast(`Banco restaurado. O anterior foi guardado em ${result.safety}. Entre novamente.`, 'success'); setTimeout(showLogin, 2500);
}
// Abas do Desenvolvedor: uma seção por vez, sem rolar a tela. A aba escolhida fica lembrada neste navegador.
const devTabKey = 'sisglosa-dev-tab';
function showDevTab(tab) {
  if (!document.querySelector(`.dev-tab[data-tab="${tab}"]`)) tab = 'saude';
  document.querySelectorAll('.dev-tab').forEach((button) => { const active = button.dataset.tab === tab; button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); });
  document.querySelectorAll('[data-dev-tab]').forEach((panel) => { panel.hidden = panel.dataset.devTab !== tab; });
  try { localStorage.setItem(devTabKey, tab); } catch {}
}
document.querySelectorAll('.dev-tab').forEach((button) => { button.onclick = () => showDevTab(button.dataset.tab); });
let savedDevTab = 'saude'; try { savedDevTab = localStorage.getItem(devTabKey) || 'saude'; } catch {}
showDevTab(savedDevTab);
const auditActions = { login: 'Entrou no sistema', login_falhou: 'Falha de login', login_bloqueado: 'Login bloqueado (muitas tentativas)', perfil_trocado: 'Trocou o perfil ativo', senha_trocada: 'Trocou a própria senha', usuario_criado: 'Criou usuário', senha_redefinida: 'Redefiniu a senha', perfis_alterados: 'Alterou perfis', usuario_removido: 'Removeu usuário', pacote_aplicado: 'Aplicou pacote', integridade_aceita: 'Aceitou o estado do código', guia_excluida: 'Excluiu guia' };
function auditDetail(entry) { const roles = (list) => (list || []).map((role) => roleLabels[role] || role).join(' + '); return [entry.target, entry.roles && roles(entry.roles), entry.role && roleLabels[entry.role], entry.version && `v${entry.version}`, entry.guide && `guia nº ${entry.guide}`].filter(Boolean).join(' · ') || '—'; }
// Um dia por vez, no fuso do navegador. O seletor lista hoje e os dias em que o sistema teve alguma ação.
const localDay = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
async function loadAudit(day = $('#audit-day').value || localDay()) {
  const [year, month, date] = day.split('-').map(Number), from = new Date(year, month - 1, date).getTime(), to = new Date(year, month - 1, date + 1).getTime();
  const { entries, days } = await api(`/api/admin/audit?desde=${from}&ate=${to}&fuso=${new Date().getTimezoneOffset()}`); const target = $('#audit-list'); target.replaceChildren();
  const today = localDay(), label = (value) => `${value === today ? 'Hoje — ' : ''}${value.split('-').reverse().join('/')}`;
  $('#audit-day').innerHTML = [...new Set([today, day, ...days])].sort().reverse().map((value) => `<option value="${value}"${value === day ? ' selected' : ''}>${label(value)}</option>`).join('');
  if (!entries.length) return emptyRow(target, 5, day === today ? 'Nenhuma ação registrada hoje.' : 'Nenhuma ação registrada neste dia.');
  entries.forEach((entry) => { const row = document.createElement('tr'); if (entry.action.startsWith('login_')) row.className = 'audit-warning'; row.innerHTML = `<td>${msDate(entry.at)}</td><td><strong>${escape(entry.username || '—')}</strong></td><td>${escape(auditActions[entry.action] || entry.action)}</td><td>${escape(auditDetail(entry))}</td><td><small class="muted">${escape(entry.ip || '—')}</small></td>`; target.append(row); });
}
$('#audit-day').onchange = (event) => loadAudit(event.target.value).catch((error) => toast(error.message, 'error'));
async function loadDeveloper() {
  loadAudit().catch((error) => toast(error.message, 'error'));
  loadMonitor().catch((error) => toast(error.message, 'error')); loadBackups().catch((error) => toast(error.message, 'error'));
  try { const health = await api('/health'); setHealth(health.status === 'ok', health.status === 'ok' ? 'Serviço respondendo normalmente.' : 'Verifique o serviço.'); } catch { setHealth(false, 'Não foi possível consultar o serviço.'); }
  try { const [system, history] = await Promise.all([api('/api/admin/system'), api('/api/admin/updates')]); renderUpdates(system, history); $('#ops-database').textContent = system.database; $('#ops-node').textContent = system.node; $('#ops-uptime').textContent = duration(system.uptime); } catch (error) { toast(error.message, 'error'); }
}
async function openGuide(number) {
  navigate('guide');
  try {
    const guide = await api(`/api/guides/${number}`); $('#guide-number').value = guide.number; $('#guide-code').value = guide.guide_code || ''; $('#ocs').value = guide.ocs; $('#patient').value = guide.patient; $('#attendance-number').value = guide.attendance_number || ''; $('#billed').value = Number(guide.billed).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); $('#items').replaceChildren(); currentGuideStatus = guide.status; activeModule = guide.items[0]?.module || modules[0]; showAll = false; guide.items.forEach((item) => addItem(item.module, item)); if (!guide.items.length) addItem(); refreshModuleOptions(); $('#add-module').value = activeModule; $('#print-guide').disabled = guide.status !== 'FINALIZADA'; setGuideEditable(guide.editable, guide.editable_until); totals(); checkAttendance(); await loadEditHistory(guide.number);
  } catch (error) {
    toast(error.message || 'Não foi possível abrir esta guia.', 'error');
    navigate('recent');
  }
}
function navigate(screen, push = true) { if (['admin', 'developer'].includes(screen) && currentSession?.role !== 'admin') return; if (['dashboard', 'guide', 'recent'].includes(screen) && currentSession?.role === 'admin') return; if (push && routes[screen] !== location.pathname) history.pushState(null, '', routes[screen]); document.querySelectorAll('.screen').forEach((item) => { item.hidden = item.id !== `${screen}-screen`; }); document.querySelectorAll('.nav-link').forEach((item) => item.classList.toggle('active', item.dataset.screen === screen)); if (screen === 'dashboard') loadDashboard().catch((error) => toast(error.message, 'error')); if (screen === 'recent') loadRecent().catch((error) => toast(error.message, 'error')); if (screen === 'admin') loadUsers().catch((error) => toast(error.message, 'error')); if (screen === 'developer') loadDeveloper(); }

$('#login-form').addEventListener('submit', async (event) => { event.preventDefault(); $('#login-error').hidden = true; try { const form = new FormData(event.currentTarget); const session = await api('/api/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(form)) }); if (session.mustChangePassword) { currentSession = session; showPasswordView(); } else showApp(session); } catch (error) { $('#login-error').textContent = error.message; $('#login-error').hidden = false; } });
$('#password-form').addEventListener('submit', async (event) => { event.preventDefault(); $('#password-error').hidden = true; try { const form = new FormData(event.currentTarget); const session = await api('/api/password', { method: 'POST', body: JSON.stringify(Object.fromEntries(form)) }); showApp(session); toast('Senha atualizada com sucesso.', 'success'); } catch (error) { $('#password-error').textContent = error.message; $('#password-error').hidden = false; } });
// Troca de perfil recarrega a página: cada perfil tem telas e dados próprios.
$('#role-switch').onchange = async (event) => { try { await api('/api/session/role', { method: 'POST', body: JSON.stringify({ role: event.target.value }) }); location.assign('/'); } catch (error) { toast(error.message, 'error'); $(`#role-switch input[value="${currentSession.role}"]`).checked = true; } };
$('#logout').onclick = async () => { await api('/api/logout', { method: 'POST' }); showLogin(); };
setTheme(localStorage.getItem(themeKey) || 'light');
$('#theme-toggle').onclick = () => { const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; localStorage.setItem(themeKey, theme); setTheme(theme); };
document.querySelectorAll('.nav-link').forEach((button) => { button.onclick = () => navigate(button.dataset.screen); });
let recentTimer; const refreshRecent = (delay = 0) => { clearTimeout(recentTimer); recentTimer = setTimeout(() => loadRecent().catch((error) => toast(error.message, 'error')), delay); };
$('#recent-filters').addEventListener('submit', (event) => { event.preventDefault(); refreshRecent(); });
$('#recent-filters').addEventListener('input', (event) => refreshRecent(event.target.name === 'q' ? 350 : 0));
$('#recent-filters').addEventListener('reset', () => refreshRecent(10));
$('#dashboard-new-guide').onclick = () => { resetGuide(true); navigate('guide'); };
$('#dashboard-open-guides').onclick = () => { $('#recent-filters').reset(); $('#recent-filters').querySelector('input[name="status"][value="RASCUNHO"]').checked = true; navigate('recent'); };
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
$('#new-guide').onclick = () => window.open('/guias?nova=1', '_blank');
$('#guide-form').addEventListener('submit', (event) => { event.preventDefault(); saveGuide().catch((error) => toast(error.message, 'error')); });
$('#save-guide').onclick = () => saveGuide().catch((error) => toast(error.message, 'error'));
$('#finalize-guide').onclick = () => finalizeGuide().catch((error) => toast(error.message, 'error'));
$('#print-guide').onclick = () => window.open(`/api/guides/${$('#guide-number').value}/report`, '_blank');
// A folha A4 tem largura fixa: reduz a escala para caber inteira na janela, sem cortar a direita.
function fitPreview() { const paper = $('#preview .document-model'); if (!paper || $('#preview-modal').hidden) return; paper.style.zoom = ''; const box = $('#preview'), style = getComputedStyle(box), room = box.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight); paper.style.zoom = Math.min(1, room / paper.offsetWidth); }
$('#module-map').addEventListener('click', (event) => { const chip = event.target.closest('.module-chip'); if (chip) activateModule(chip.dataset.module); });
// Resumo de uma guia no painel: valores e totais por módulo, sem abrir a edição.
async function showGuideSummary(number) {
  const guide = await api(`/api/guides/${number}`), sum = (prefix) => guide.items.filter((item) => item.module.startsWith(prefix)).reduce((total, item) => total + item.amount, 0), glosa = sum('Glosa'), ajuste = sum('Ajuste');
  $('#summary-title').textContent = `Resumo da guia nº ${guide.number}`;
  $('#summary-identity').innerHTML = `${escape(guide.ocs || 'OCS não informada')} · ${escape(guide.patient || 'Paciente não informado')}${guide.attendance_number ? ` · Atendimento ${escape(guide.attendance_number)}` : ''} ${statusBadge(guide.status)}`;
  $('#summary-billed').textContent = format(guide.billed); $('#summary-glosa').textContent = format(glosa); $('#summary-ajuste').textContent = format(ajuste); $('#summary-audited').textContent = format(guide.billed - glosa + ajuste);
  $('#summary-glosa-rate').textContent = guide.billed ? `${(glosa / guide.billed * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% do valor apresentado` : '';
  const byModule = {}; guide.items.forEach((item) => { const row = byModule[item.module] ||= { total: 0, items: 0 }; row.total += item.amount; row.items += 1; });
  const ranked = Object.entries(byModule).sort((a, b) => b[1].total - a[1].total), top = Math.max(0, ...ranked.map(([, row]) => row.total)), list = $('#summary-modules'); list.replaceChildren();
  if (!ranked.length) list.innerHTML = '<li class="empty-ranking">Nenhum item lançado nesta guia.</li>';
  ranked.forEach(([module, row]) => { const item = document.createElement('li'); item.className = module.startsWith('Glosa') ? 'glosa' : 'ajuste'; item.innerHTML = `<div><span>${escape(module)}</span><strong>${format(row.total)}</strong></div><span class="ranking-bar"><span style="width:${top ? Math.max(3, row.total / top * 100) : 3}%"></span></span><small>${row.items} ${row.items === 1 ? 'item' : 'itens'}</small>`; list.append(item); });
  $('#summary-open').href = `/guias?guia=${guide.number}`; $('#summary-open').lastChild.textContent = guide.editable === false ? 'Consultar guia' : 'Abrir guia';
  $('#summary-pdf').hidden = guide.status !== 'FINALIZADA'; $('#summary-pdf').onclick = () => window.open(`/api/guides/${guide.number}/report`, '_blank');
  $('#summary-modal').hidden = false; $('#summary-close').focus();
}
$('#summary-close').onclick = () => { $('#summary-modal').hidden = true; };
$('#summary-modal').onclick = (event) => { if (event.target === $('#summary-modal')) $('#summary-close').click(); };
$('#preview-guide').onclick = () => { renderPreview(); $('#preview-modal').hidden = false; fitPreview(); $('#preview-modal-close').focus(); };
addEventListener('resize', fitPreview);
$('#preview-modal-close').onclick = () => { $('#preview-modal').hidden = true; $('#preview-guide').focus(); };
$('#preview-modal').onclick = (event) => { if (event.target === $('#preview-modal')) $('#preview-modal-close').click(); };
['guide-code', 'ocs', 'patient', 'attendance-number'].forEach((id) => $("#" + id).addEventListener('input', () => { totals(); persistDraft(); })); $('#attendance-number').addEventListener('input', checkAttendance); bindMoneyInput($('#billed'));
bindSuggestions($('#ocs'), () => ocsOptions, 'ocs');
bindSuggestions($('#patient'), () => patientOptions, 'patients');
$('#previous-module').onclick = () => activateModule(modules[Math.max(0, modules.indexOf(activeModule) - 1)]);
$('#next-module').onclick = () => activateModule(modules[Math.min(modules.length - 1, modules.indexOf(activeModule) + 1)]);
$('#show-all').onclick = () => { showAll = !showAll; renderFlow(); };

$('#new-user-form').addEventListener('submit', async (event) => { event.preventDefault(); const formElement = event.currentTarget; const button = $('button', formElement); if (button.disabled) return; button.disabled = true; try { const form = new FormData(formElement); const user = await api('/api/users', { method: 'POST', body: JSON.stringify({ username: form.get('username'), roles: form.getAll('roles') }) }); formElement.reset(); toast(`Usuário ${user.username} criado. Senha temporária: ${user.temporaryPassword}.`, 'success'); await loadUsers(); } catch (error) { if (error.message === 'Esse usuário já existe.') await loadUsers(); toast(error.message, 'error'); } finally { button.disabled = false; } });
const showFileName = () => { $('#update-file-name').textContent = $('#update-file').files[0]?.name || 'Nenhum arquivo selecionado'; };
$('#update-file').addEventListener('change', showFileName); $('#update-form').addEventListener('reset', () => setTimeout(() => { showFileName(); delete $('#update-next-version').dataset.edited; suggestVersion(); $('#update-message-count').textContent = '0'; }));
$('#update-form').addEventListener('change', (event) => { if (event.target.name === 'type') suggestVersion(); });
$('#update-next-version').addEventListener('input', (event) => { event.currentTarget.dataset.edited = '1'; });
$('#update-message').addEventListener('input', (event) => { $('#update-message-count').textContent = event.currentTarget.value.length; });
// XHR em vez de fetch: só ele informa o progresso do envio do arquivo.
function setUpdateProgress(percent, step) { $('#update-progress').hidden = false; $('#update-progress-bar').value = percent; $('#update-progress-percent').textContent = `${percent}%`; $('#update-progress-step').textContent = step; }
function uploadPackage(file, headers) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); xhr.open('POST', '/api/admin/updates'); xhr.setRequestHeader('Content-Type', 'application/zip'); Object.entries(headers).forEach(([name, value]) => xhr.setRequestHeader(name, value));
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) setUpdateProgress(Math.round(event.loaded / event.total * 70), 'Enviando o pacote…'); };
    xhr.upload.onload = () => setUpdateProgress(80, 'Validando, copiando os arquivos e aplicando…');
    xhr.onload = () => { let data = null; try { data = JSON.parse(xhr.responseText); } catch {} if (xhr.status === 401) { showLogin(); return reject(new Error('Sessão expirada.')); } if (xhr.status >= 200 && xhr.status < 300) { setUpdateProgress(100, 'Atualização concluída.'); resolve(data); } else { setUpdateProgress(100, 'Pacote recusado.'); reject(new Error(data?.error || 'Não foi possível aplicar o pacote.')); } };
    xhr.onerror = () => reject(new Error('Falha de comunicação durante o envio do pacote.'));
    setUpdateProgress(0, 'Enviando o pacote…'); xhr.send(file);
  });
}
$('#update-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget, file = $('#update-file').files[0], button = $('button[type="submit"]', form);
  const version = form.elements.version.value.trim(), type = form.elements.type.value, message = form.elements.message.value.trim();
  if (!file) return toast('Selecione um pacote ZIP.', 'error');
  if (!await confirmAction(`Aplicar ${file.name} (${updateKinds[type].toLowerCase()})? A versão e a descrição do pacote têm prioridade; uma versão menor que a ativa reverte o sistema. Os arquivos são gravados após validação.`, { title: 'Aplicar atualização', confirm: 'Aplicar' })) return;
  button.disabled = true; $('#update-status').className = 'update-note'; $('#update-status').textContent = 'Validando e aplicando o pacote…';
  try {
    const result = await uploadPackage(file, { 'X-Update-Filename': encodeURIComponent(file.name), 'X-Update-Version': version, 'X-Update-Type': type, 'X-Update-Message': encodeURIComponent(message) });
    form.reset(); $('#update-status').className = 'update-note ok'; $('#update-status').textContent = `Versão ${result.version} ${result.reverted ? 'aplicada (reversão para uma versão anterior)' : 'aplicada'} (${result.files.length} ${result.files.length === 1 ? 'arquivo' : 'arquivos'}${result.created?.length ? `, ${result.created.length} novo${result.created.length > 1 ? 's' : ''}` : ''}). Cópia de segurança em ${result.backup}.${result.autoRestart ? ' O serviço está reiniciando sozinho; recarregue a página em alguns segundos.' : result.restartRequired ? ' Reinicie o serviço para carregar a atualização do servidor.' : ' Recarregue a página para usar a nova interface.'}`; toast(result.reverted ? `Sistema revertido para a versão ${result.version}.` : `Atualização ${result.version} aplicada.`, 'success'); await loadDeveloper();
  } catch (error) { $('#update-status').className = 'update-note bad'; $('#update-status').textContent = error.message; toast(error.message, 'error'); } finally { button.disabled = false; }
});

addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('#summary-modal').hidden) $('#summary-close').click();
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && !$('#guide-screen').hidden && currentSession?.role !== 'admin') {
    event.preventDefault(); if (currentGuideEditable) saveGuide().catch((error) => toast(error.message, 'error'));
  }
});
$('#monitor-check').onclick = async (event) => { const button = event.currentTarget; button.disabled = true; try { renderMonitor(await api('/api/admin/monitor/check', { method: 'POST' })); toast('Verificação concluída.', 'success'); } catch (error) { toast(error.message, 'error'); } finally { button.disabled = false; } };
$('#monitor-accept').onclick = async () => { const values = await promptFields('Aceitar estado atual', 'Os arquivos de código como estão agora passam a ser a referência do monitor de integridade. Confirme só se a mudança foi feita por você ou pela equipe.', [passwordField], { confirm: 'Aceitar' }); if (!values) return; try { renderMonitor(await api('/api/admin/monitor/accept', { method: 'POST', body: JSON.stringify(values) })); toast('Referência de integridade atualizada.', 'success'); } catch (error) { toast(error.message, 'error'); } };
$('#backup-create').onclick = async (event) => { const button = event.currentTarget; button.disabled = true; try { const backup = await api('/api/admin/backups', { method: 'POST' }); toast(backup.ok ? 'Backup gerado e conferido.' : 'Backup gerado, mas a verificação falhou.', backup.ok ? 'success' : 'error'); await Promise.all([loadBackups(), loadMonitor()]); } catch (error) { toast(error.message, 'error'); } finally { button.disabled = false; } };
// Com a tela Desenvolvedor aberta, a saúde se atualiza sozinha a cada minuto.
setInterval(() => { if (currentSession?.role === 'admin' && !$('#developer-screen').hidden) loadMonitor().catch(() => {}); }, 60000);
addEventListener('popstate', () => currentSession && navigate(routeScreen[location.pathname] || (currentSession.role === 'admin' ? 'admin' : 'dashboard'), false));
api('/api/session').then((session) => session?.username ? (session.mustChangePassword ? showPasswordView() : showApp(session)) : showLogin()).catch(showLogin);
