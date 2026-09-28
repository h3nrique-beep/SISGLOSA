const modules = ['Ajuste de honorários', 'Ajuste de exame laboratorial', 'Ajuste de exame de imagem', 'Glosa de honorário médico', 'Glosa de taxa', 'Glosa de material', 'Glosa de medicamento', 'Glosa de exame de imagem', 'Glosa de exame laboratorial', 'Glosa de nutrição', 'Glosa de OPME', 'Glosa de fisioterapia'];
const $ = (selector, root = document) => root.querySelector(selector);
const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
let activeModule = modules[0];
let showAll = false;
let draftTimer;
let currentSession;
let guideFilter = '';
const draftKey = 'pmgu-guide-draft';
const routes = { dashboard: '/', guide: '/guias', recent: '/registros', admin: '/administracao', developer: '/desenvolvedor' };
const routeScreen = Object.fromEntries(Object.entries(routes).map(([screen, route]) => [route, screen]));

function isHonor(module) { return module.includes('honorário'); }
function isAdjustment(module) { return module.startsWith('Ajuste'); }
function amount(value) { return Number(String(value ?? '').replace(/[^0-9,-]/g, '').replace(/\./g, '').replace(',', '.')) || 0; }
function format(value) { return money.format(Number(value || 0)); }
function escape(value) { return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]); }
function adjustmentText(value) { return `Ajuste, será pago R$ ${value} conforme as regras da CBHPM Edição 2014 e de acordo com o item 5 do referencial de custos do contrato.`; }
function adjustmentValue(text) { return String(text || '').match(/^Ajuste, será pago R\$\s*(.*?)\s*conforme as regras da CBHPM Edição 2014 e de acordo com o item 5 do referencial de custos do contrato\.$/)?.[1] || '0,00'; }
function toast(message, type = '') { const box = $('#toast'); box.textContent = message; box.className = `show ${type}`; clearTimeout(box.timer); box.timer = setTimeout(() => { box.className = ''; }, 3600); }
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
function showApp(session) { currentSession = session; const admin = session.role === 'admin'; const screen = routeScreen[location.pathname]; $('#username').textContent = session.username; document.querySelectorAll('.admin-only').forEach((item) => { item.hidden = !admin; }); document.querySelectorAll('.guide-only').forEach((item) => { item.hidden = admin; }); $('#login-view').hidden = true; $('#login-view').style.display = 'none'; $('#password-view').hidden = true; $('#app-view').hidden = false; $('#app-view').style.display = 'block'; document.body.classList.remove('loading'); if (admin) return navigate(screen === 'developer' ? 'developer' : 'admin', !['admin', 'developer'].includes(screen)); resetGuide(); restoreDraft(); totals(); loadOcs(); loadRecent(); navigate(['dashboard', 'guide', 'recent'].includes(screen) ? screen : 'dashboard', !['dashboard', 'guide', 'recent'].includes(screen)); }

function moduleOptions(selected) {
  return ['Ajuste', 'Glosa'].map((prefix) => `<optgroup label="${prefix}s">${modules.filter((module) => module.startsWith(prefix)).map((module) => `<option value="${module}" ${module === selected ? 'selected' : ''}>${module}</option>`).join('')}</optgroup>`).join('');
}
function setJustificationMode(row) { const adjustment = isAdjustment($('.module', row).value); $('.justification', row).hidden = adjustment; $('.justification', row).required = !adjustment; $('.adjustment-justification', row).hidden = !adjustment; $('.adjustment-value', row).required = adjustment; }
function rowValues(row) { const module = $('.module', row).value; return { module, specification: $('.specification', row).value, specialty: $('.specialty', row).value, crm: $('.crm', row).value, justification: isAdjustment(module) ? adjustmentText($('.adjustment-value', row).value) : $('.justification', row).value, amount: amount($('.amount', row).value) }; }
function rows() { return [...$('#items').rows]; }
function addItem(module = activeModule, item = {}) {
  const row = $('#item-template').content.firstElementChild.cloneNode(true);
  $('.module', row).innerHTML = moduleOptions(item.module || module);
  $('.specification', row).value = item.specification || '';
  $('.specialty', row).value = item.specialty || '';
  $('.crm', row).value = item.crm || '';
  $('.justification', row).value = item.justification || '';
  $('.adjustment-value', row).value = adjustmentValue(item.justification);
  $('.amount', row).value = item.amount === undefined ? '0,00' : Number(item.amount).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  setJustificationMode(row);
  $('.module', row).addEventListener('change', () => { $('.specification', row).value = ''; $('.specialty', row).value = ''; $('.crm', row).value = ''; $('.justification', row).value = ''; $('.adjustment-value', row).value = '0,00'; $('.amount', row).value = '0,00'; activeModule = $('.module', row).value; setJustificationMode(row); showAll = false; renderFlow(); loadSpecifications(activeModule); totals(); persistDraft(); });
  $('.remove', row).addEventListener('click', () => { row.remove(); totals(); renderFlow(); persistDraft(); });
  row.addEventListener('input', () => { totals(); persistDraft(); });
  $('.amount', row).addEventListener('focus', (event) => event.target.select());
  $('.adjustment-value', row).addEventListener('focus', (event) => event.target.select());
  $('.adjustment-value', row).addEventListener('focusout', (event) => { event.target.value = Number(amount(event.target.value)).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); totals(); persistDraft(); });
  row.addEventListener('focusout', (event) => { if (event.target.classList.contains('amount')) { event.target.value = Number(amount(event.target.value)).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); totals(); } });
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
  if (!rows().some((row) => $('.module', row).value === module)) addItem(module); else renderFlow();
  loadSpecifications(module); persistDraft();
}
function totals() {
  const data = rows().map(rowValues); const billed = amount($('#billed').value); const glosa = data.filter((item) => item.module.startsWith('Glosa')).reduce((sum, item) => sum + item.amount, 0); const ajuste = data.filter((item) => item.module.startsWith('Ajuste')).reduce((sum, item) => sum + item.amount, 0);
  $('#billed-total').textContent = format(billed); $('#glosa-total').textContent = format(glosa); $('#ajuste-total').textContent = format(ajuste); $('#auditado-total').textContent = format(billed - glosa - ajuste);
  preview(data, billed, glosa, ajuste);
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
  $('#preview').innerHTML = `<article class="document-model"><div class="official"><img class="official-logo" src="/template-logo.png" alt="Exército Brasileiro">MINISTÉRIO DA DEFESA<br>EXÉRCITO BRASILEIRO<br>CMDO 15ª BDA INF MEC</div><p class="identity">OCS: ${escape($('#ocs').value)}<br>PACIENTE: ${escape($('#patient').value)}<br>GUIA Nº: ${escape($('#guide-number').value)}</p><table class="summary"><thead><tr><th>Valor<br>Apresentado</th><th>Glosa</th><th>Ajuste</th><th>Valor<br>Auditado</th><th>Observação</th></tr></thead><tbody><tr><td class="money">${format(billed)}</td><td class="money">${format(glosa)}</td><td class="money">${format(ajuste)}</td><td class="money">${format(billed - glosa - ajuste)}</td><td class="observation">Com relação às glosas e possíveis recursos, favor cumprir rigorosamente os prazos e procedimentos previstos nas cláusulas 7.1.21 até a cláusula 7.1.31 do Termo de Contrato celebrado entre as partes.</td></tr></tbody></table>${previewSections(items, 'Ajuste', 'RELATÓRIO DE AJUSTE')}${previewSections(items, 'Glosa', 'RELATÓRIO DE GLOSA')}<p style="margin-top:26px">Quartel em Cascavel-PR, ${new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })}</p><div class="signatures"><div>Médico Auditor da Seção de Auditoria de Contas Médicas</div><div>Enfermeira Auditora da Seção de Auditoria de Contas Médicas</div></div></article>`;
}
function persistDraft() { clearTimeout(draftTimer); draftTimer = setTimeout(() => sessionStorage.setItem(draftKey, JSON.stringify({ ocs: $('#ocs').value, patient: $('#patient').value, billed: $('#billed').value, activeModule, items: rows().map(rowValues) })), 250); }
function restoreDraft() {
  try { const draft = JSON.parse(sessionStorage.getItem(draftKey)); if (!draft?.items?.length) return; $('#ocs').value = draft.ocs || ''; $('#patient').value = draft.patient || ''; $('#billed').value = draft.billed || '0,00'; $('#items').replaceChildren(); activeModule = modules.includes(draft.activeModule) ? draft.activeModule : modules[0]; draft.items.forEach((item) => addItem(item.module, item)); } catch { sessionStorage.removeItem(draftKey); }
}
async function loadOcs() { const values = await api('/api/options/ocs'); $('#ocs-options').replaceChildren(...values.map((value) => Object.assign(document.createElement('option'), { value }))); }
async function loadSpecifications(module) { const values = await api(`/api/options/specifications?module=${encodeURIComponent(module)}`); $('#specifications').replaceChildren(...values.map((value) => Object.assign(document.createElement('option'), { value }))); }
function resetGuide(clearDraft = false) { if (clearDraft) sessionStorage.removeItem(draftKey); $('#guide-form').reset(); $('#guide-number').value = ''; $('#items').replaceChildren(); activeModule = modules[0]; showAll = false; addItem(); $('#print-guide').disabled = true; $('#billed').value = '0,00'; totals(); navigate('guide', false); }
async function saveGuide(status = 'RASCUNHO') {
  const items = rows().map(rowValues); const saved = await api('/api/guides', { method: 'POST', body: JSON.stringify({ number: $('#guide-number').value || 0, ocs: $('#ocs').value, patient: $('#patient').value, billed: amount($('#billed').value), items, status }) });
  $('#guide-number').value = saved.number; $('#print-guide').disabled = saved.status !== 'FINALIZADA'; sessionStorage.removeItem(draftKey); toast(status === 'FINALIZADA' ? 'Guia finalizada com sucesso.' : 'Rascunho salvo com sucesso.', 'success'); loadOcs(); loadRecent(); if (status === 'RASCUNHO') resetGuide(true); return saved;
}
async function finalizeGuide() { if (!await confirmAction('A guia será finalizada e aberta para impressão.', { title: 'Finalizar guia', confirm: 'Finalizar' })) return; const report = window.open('', '_blank'); try { const saved = await saveGuide('FINALIZADA'); if (report) report.location = `/api/guides/${saved.number}/report`; } catch (error) { report?.close(); throw error; } }
function statusBadge(status) { return `<span class="guide-status ${status === 'FINALIZADA' ? 'finalized' : 'draft'}">${status === 'FINALIZADA' ? 'Finalizada' : 'Rascunho'}</span>`; }
async function loadDashboard() { const data = await api('/api/dashboard'); $('#dashboard-total').textContent = data.total; $('#dashboard-open').textContent = data.open; $('#dashboard-finalized').textContent = data.finalized; const target = $('#dashboard-guides'); target.replaceChildren(); data.recent.forEach((guide) => { const row = document.createElement('tr'); row.innerHTML = `<td>${guide.number}</td><td>${escape(guide.ocs || '—')}</td><td>${escape(guide.patient || '—')}</td><td>${statusBadge(guide.status)}</td><td>${new Date(`${guide.created_at}Z`).toLocaleDateString('pt-BR')}</td><td><button class="text-button open">Abrir</button></td>`; $('.open', row).onclick = () => openGuide(guide.number); target.append(row); }); }
async function loadRecent() {
  const guides = await api(`/api/guides${guideFilter ? `?status=${guideFilter}` : ''}`); const target = $('#recent-guides'); target.replaceChildren(); $('#recent-description').textContent = guideFilter ? 'Guias em aberto: continue a edição ou finalize quando estiver pronta.' : 'Abra, imprima ou exclua uma guia.';
  guides.forEach((guide) => { const row = document.createElement('tr'); row.innerHTML = `<td>${escape(guide.ocs || '—')}</td><td>${escape(guide.patient || '—')}</td><td>${format(guide.billed)}</td><td>${statusBadge(guide.status)}</td><td>${new Date(`${guide.created_at}Z`).toLocaleDateString('pt-BR')}</td><td class="row-actions"><button class="text-button open">Abrir</button>${guide.status === 'FINALIZADA' ? '<button class="text-button report">PDF</button>' : ''}<button class="text-button delete danger-text">Excluir</button></td>`; $('.open', row).onclick = () => openGuide(guide.number); if (guide.status === 'FINALIZADA') $('.report', row).onclick = () => window.open(`/api/guides/${guide.number}/report`, '_blank'); $('.delete', row).onclick = async () => { if (!await confirmAction('Esta guia e seus itens serão removidos.', { title: 'Excluir guia', confirm: 'Excluir', danger: true })) return; await api(`/api/guides/${guide.number}`, { method: 'DELETE' }); toast('Guia excluída.', 'success'); loadRecent(); loadDashboard(); }; target.append(row); });
}
async function loadUsers() {
  const users = await api('/api/users'); const target = $('#users'); target.replaceChildren();
  $('#user-count').textContent = users.length; $('#pending-password-count').textContent = users.filter((user) => Number(user.must_change_password)).length;
  users.forEach((user) => { const row = document.createElement('tr'); const pending = Number(user.must_change_password); const removable = user.role !== 'admin'; row.innerHTML = `<td><strong>${escape(user.username)}</strong></td><td><span class="role-badge">${user.role === 'admin' ? 'Administrador' : 'Usuário'}</span></td><td><span class="status-badge ${pending ? 'pending' : 'ready'}">${pending ? 'Troca obrigatória' : 'Regular'}</span></td><td><button class="text-button reset-user">Redefinir senha</button>${removable ? '<button class="text-button delete-user danger-text">Remover</button>' : ''}</td>`; $('.reset-user', row).onclick = async () => { if (!await confirmAction(`A senha de ${user.username} será redefinida para 123456.`, { title: 'Redefinir senha', confirm: 'Redefinir', danger: true })) return; await api(`/api/users/${user.id}/reset-password`, { method: 'POST' }); toast(`Senha de ${user.username} redefinida para 123456.`, 'success'); loadUsers(); }; if (removable) $('.delete-user', row).onclick = async () => { if (!await confirmAction(`Remover o usuário ${user.username}? Esta ação não pode ser desfeita.`, { title: 'Remover usuário', confirm: 'Remover', danger: true })) return; await api(`/api/users/${user.id}`, { method: 'DELETE' }); toast(`Usuário ${user.username} removido.`, 'success'); loadUsers(); }; target.append(row); });
}
async function loadDeveloper() { try { const health = await api('/health'); $('#health-status').textContent = health.status === 'ok' ? 'Online' : 'Indisponível'; $('#health-detail').textContent = health.status === 'ok' ? 'Serviço respondendo normalmente.' : 'Verifique o serviço.'; } catch { $('#health-status').textContent = 'Indisponível'; $('#health-detail').textContent = 'Não foi possível consultar o serviço.'; } }
async function openGuide(number) {
  const guide = await api(`/api/guides/${number}`); $('#guide-number').value = guide.number; $('#ocs').value = guide.ocs; $('#patient').value = guide.patient; $('#billed').value = Number(guide.billed).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); $('#items').replaceChildren(); activeModule = guide.items[0]?.module || modules[0]; showAll = false; guide.items.forEach((item) => addItem(item.module, item)); if (!guide.items.length) addItem(); $('#print-guide').disabled = guide.status !== 'FINALIZADA'; totals(); navigate('guide');
}
function navigate(screen, push = true) { if (['admin', 'developer'].includes(screen) && currentSession?.role !== 'admin') return; if (['dashboard', 'guide', 'recent'].includes(screen) && currentSession?.role === 'admin') return; if (push && routes[screen] !== location.pathname) history.pushState(null, '', routes[screen]); document.querySelectorAll('.screen').forEach((item) => { item.hidden = item.id !== `${screen}-screen`; }); document.querySelectorAll('.nav-link').forEach((item) => item.classList.toggle('active', item.dataset.screen === screen)); if (screen === 'dashboard') loadDashboard().catch((error) => toast(error.message, 'error')); if (screen === 'recent') loadRecent(); if (screen === 'admin') loadUsers().catch((error) => toast(error.message, 'error')); if (screen === 'developer') loadDeveloper(); }

$('#login-form').addEventListener('submit', async (event) => { event.preventDefault(); $('#login-error').hidden = true; try { const form = new FormData(event.currentTarget); const session = await api('/api/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(form)) }); if (session.mustChangePassword) { currentSession = session; showPasswordView(); } else showApp(session); } catch (error) { $('#login-error').textContent = error.message; $('#login-error').hidden = false; } });
$('#password-form').addEventListener('submit', async (event) => { event.preventDefault(); $('#password-error').hidden = true; try { const form = new FormData(event.currentTarget); const session = await api('/api/password', { method: 'POST', body: JSON.stringify(Object.fromEntries(form)) }); showApp(session); toast('Senha atualizada com sucesso.', 'success'); } catch (error) { $('#password-error').textContent = error.message; $('#password-error').hidden = false; } });
$('#logout').onclick = async () => { await api('/api/logout', { method: 'POST' }); showLogin(); };
document.querySelectorAll('.nav-link').forEach((button) => { button.onclick = () => { if (button.dataset.screen === 'recent') guideFilter = ''; navigate(button.dataset.screen); }; });
$('#dashboard-new-guide').onclick = () => { resetGuide(true); navigate('guide'); };
$('#dashboard-open-guides').onclick = () => { guideFilter = 'RASCUNHO'; navigate('recent'); };
$('#add-item').onclick = () => { const row = addItem(); persistDraft(); $('.specification', row).focus(); };
$('#new-guide').onclick = () => window.open('/guias', '_blank');
$('#guide-form').addEventListener('submit', (event) => { event.preventDefault(); saveGuide().catch((error) => toast(error.message, 'error')); });
$('#save-guide').onclick = () => saveGuide().catch((error) => toast(error.message, 'error'));
$('#finalize-guide').onclick = () => finalizeGuide().catch((error) => toast(error.message, 'error'));
$('#print-guide').onclick = () => window.open(`/api/guides/${$('#guide-number').value}/report`, '_blank');
['ocs', 'patient', 'billed'].forEach((id) => $("#" + id).addEventListener('input', () => { totals(); persistDraft(); })); $('#billed').addEventListener('focus', (event) => event.target.select()); $('#billed').addEventListener('focusout', () => { $('#billed').value = Number(amount($('#billed').value)).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); totals(); persistDraft(); });
$('#previous-module').onclick = () => activateModule(modules[Math.max(0, modules.indexOf(activeModule) - 1)]);
$('#next-module').onclick = () => activateModule(modules[Math.min(modules.length - 1, modules.indexOf(activeModule) + 1)]);
$('#show-all').onclick = () => { showAll = !showAll; renderFlow(); };

$('#new-user-form').addEventListener('submit', async (event) => { event.preventDefault(); const formElement = event.currentTarget; const button = $('button', formElement); if (button.disabled) return; button.disabled = true; try { const form = new FormData(formElement); const user = await api('/api/users', { method: 'POST', body: JSON.stringify(Object.fromEntries(form)) }); formElement.reset(); toast(`Usuário ${user.username} criado. Senha temporária: 123456.`, 'success'); await loadUsers(); } catch (error) { if (error.message === 'Esse usuário já existe.') await loadUsers(); toast(error.message, 'error'); } finally { button.disabled = false; } });

addEventListener('popstate', () => currentSession && navigate(routeScreen[location.pathname] || (currentSession.role === 'admin' ? 'admin' : 'dashboard'), false));
api('/api/session').then((session) => session?.username ? (session.mustChangePassword ? showPasswordView() : showApp(session)) : showLogin()).catch(showLogin);
