// Regras do domínio da auditoria: módulos padrão, ajuste x glosa e cálculo do valor auditado.
const MODULES = [
  'Ajuste de honorários', 'Ajuste de exame laboratorial', 'Ajuste de exame de imagem',
  'Glosa de honorário médico', 'Glosa de taxa', 'Glosa de material', 'Glosa de medicamento',
  'Glosa de exame de imagem', 'Glosa de exame laboratorial', 'Glosa de nutrição', 'Glosa de OPME', 'Glosa de fisioterapia',
];
const DEFAULT_ADJUSTMENT_JUSTIFICATION = 'Ajuste, será pago R$ conforme as regras da CBHPM Edição 2014 e de acordo com o item 5 do referencial de custos do contrato.';
const isHonor = (module) => module.includes('honorário');
const hasSector = (module) => ['Glosa de material', 'Glosa de medicamento'].includes(module);
// Módulo criado na guia: "Ajuste: nome" ou "Glosa: nome".
const validModule = (module) => MODULES.includes(module) || /^(Ajuste|Glosa):\s+\S/.test(module);
const sumKind = (items, prefix) => items.filter((item) => item.module.startsWith(prefix)).reduce((sum, item) => sum + Number(item.amount), 0);
function totals(items, billed) {
  const glosa = sumKind(items, 'Glosa'), ajuste = sumKind(items, 'Ajuste');
  return { glosa, ajuste, auditado: Number(billed) - glosa + ajuste };
}

module.exports = { MODULES, DEFAULT_ADJUSTMENT_JUSTIFICATION, isHonor, hasSector, validModule, sumKind, totals };
