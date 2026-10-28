/**
 * Reading and editing the theme files and the theme registry for the dev-only
 * theme editor.
 *
 * Each file in src/themes/ is one rule of custom properties, edited by hand as
 * often as by the editor, so CSS goes through postcss and only the values that
 * change are touched: comments, order and formatting survive a save. The
 * registry is TypeScript, so it is located with the compiler API and edited by
 * splicing text at node positions.
 */

import postcss from 'postcss';
import ts from 'typescript';

/** The heading of the custom properties declared before the rule's first comment. */
export const BASE_GROUP_TITLE = 'Base colors';

/** The one rule a theme file holds. */
function themeRule(root) {
  const rules = root.nodes.filter((node) => node.type === 'rule');
  if (rules.length !== 1) throw new Error(`Expected one rule in the theme file, found ${rules.length}.`);
  return rules[0];
}

function colorSchemeDeclaration(rule) {
  return rule.nodes.find((node) => node.type === 'decl' && node.prop === 'color-scheme');
}

/**
 * A theme file's selector, colour scheme, and custom properties.
 *
 * Properties are grouped under the nearest comment before them inside the
 * rule; those before any comment are the base palette. `colorScheme` is null
 * for a file that declares none, which is the default theme.
 */
export function readTheme(cssText) {
  const rule = themeRule(postcss.parse(cssText));
  const groups = [];
  let current = null;
  for (const node of rule.nodes) {
    if (node.type === 'comment') {
      current = { title: node.text, tokens: [] };
      groups.push(current);
    } else if (node.type === 'decl' && node.prop.startsWith('--')) {
      if (!current) {
        current = { title: BASE_GROUP_TITLE, tokens: [] };
        groups.push(current);
      }
      current.tokens.push({ name: node.prop, value: node.value });
    }
  }
  return {
    selector: rule.selector,
    colorScheme: colorSchemeDeclaration(rule)?.value ?? null,
    groups: groups.filter((group) => group.tokens.length > 0)
  };
}

/** Throws unless `value` is exactly one declaration's value, so it cannot end the rule or add a property. */
function assertDeclarationValue(name, value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`The value of ${name} must be a non-empty string.`);
  }
  let root;
  try {
    root = postcss.parse(`:root{--x:${value}}`);
  } catch {
    throw new Error(`The value of ${name} is not valid CSS: ${value}`);
  }
  const [rule] = root.nodes;
  if (
    root.nodes.length !== 1
    || rule.type !== 'rule'
    || rule.nodes.length !== 1
    || rule.nodes[0].type !== 'decl'
    || rule.nodes[0].value !== value
  ) {
    throw new Error(`The value of ${name} is not a single CSS value: ${value}`);
  }
}

/**
 * Set custom property values and the colour scheme, and nothing else.
 *
 * Every name must already be declared, and `colorScheme` is null exactly when
 * the file declares none: an edit never adds or removes a declaration.
 */
export function applyThemeEdits(cssText, { colorScheme, values }) {
  const root = postcss.parse(cssText);
  const rule = themeRule(root);
  const scheme = colorSchemeDeclaration(rule);
  if (colorScheme === null) {
    if (scheme) throw new Error('This theme declares a color-scheme, so it needs one.');
  } else {
    if (colorScheme !== 'light' && colorScheme !== 'dark') {
      throw new Error(`color-scheme must be "light" or "dark", not ${JSON.stringify(colorScheme)}.`);
    }
    if (!scheme) throw new Error('This theme declares no color-scheme, so it cannot be given one.');
    if (scheme.value !== colorScheme) scheme.value = colorScheme;
  }
  for (const [name, value] of Object.entries(values)) {
    const declarations = rule.nodes.filter((node) => node.type === 'decl' && node.prop === name);
    if (!name.startsWith('--') || declarations.length === 0) {
      throw new Error(`This theme declares no custom property ${name}.`);
    }
    assertDeclarationValue(name, value);
    for (const declaration of declarations) {
      if (declaration.value !== value) declaration.value = value;
    }
  }
  return root.toString();
}

/** The selector pair every selectable theme is written with. */
export const themeSelector = (id) => `:root[data-theme="${id}"], [data-theme-preview="${id}"]`;

/** A copy of a theme under a new id, with its header comment naming the copy. */
export function duplicateTheme(cssText, { id, label }) {
  const root = postcss.parse(cssText);
  const header = root.first;
  if (header?.type !== 'comment') throw new Error('The theme to copy has no header comment.');
  if (label.includes('*/')) throw new Error('A theme label cannot contain "*/".');
  header.text = `${label}.`;
  themeRule(root).selector = themeSelector(id);
  return root.toString();
}

const REGISTRY_NAME = 'THEME_OPTIONS';
const REGISTRY_FIELDS = ['id', 'label', 'group'];

/** Each object literal of THEME_OPTIONS, with its fields' string literal nodes. */
function registryElements(tsText) {
  const source = ts.createSourceFile('app-theme.ts', tsText, ts.ScriptTarget.Latest, true);
  let array = null;
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== REGISTRY_NAME) continue;
      let initializer = declaration.initializer;
      if (initializer && ts.isAsExpression(initializer)) initializer = initializer.expression;
      if (initializer && ts.isArrayLiteralExpression(initializer)) array = initializer;
    }
  }
  if (!array) throw new Error(`Found no ${REGISTRY_NAME} array in the registry.`);
  return array.elements.map((element) => {
    if (!ts.isObjectLiteralExpression(element)) {
      throw new Error(`Every ${REGISTRY_NAME} entry must be an object literal.`);
    }
    const fields = {};
    for (const property of element.properties) {
      if (
        ts.isPropertyAssignment(property)
        && ts.isIdentifier(property.name)
        && REGISTRY_FIELDS.includes(property.name.text)
        && ts.isStringLiteral(property.initializer)
      ) {
        fields[property.name.text] = property.initializer;
      }
    }
    if (!REGISTRY_FIELDS.every((field) => field in fields)) {
      throw new Error(`Every ${REGISTRY_NAME} entry needs string id, label and group fields.`);
    }
    return { node: element, fields };
  });
}

function registryElement(tsText, id) {
  const element = registryElements(tsText).find(({ fields }) => fields.id.text === id);
  if (!element) throw new Error(`The registry has no theme "${id}".`);
  return element;
}

const entryText = ({ id, label, group }) =>
  `{ id: ${JSON.stringify(id)}, label: ${JSON.stringify(label)}, group: ${JSON.stringify(group)} }`;

/** Every registry entry, in order. */
export function readRegistry(tsText) {
  return registryElements(tsText).map(({ fields }) => ({
    id: fields.id.text,
    label: fields.label.text,
    group: fields.group.text
  }));
}

/** Insert an entry after the last one in its group, or at the end when the group is new. */
export function addRegistryEntry(tsText, entry) {
  const elements = registryElements(tsText);
  if (elements.some(({ fields }) => fields.id.text === entry.id)) {
    throw new Error(`The registry already has a theme "${entry.id}".`);
  }
  if (elements.length === 0) throw new Error(`${REGISTRY_NAME} is empty.`);
  const sameGroup = elements.filter(({ fields }) => fields.group.text === entry.group);
  const after = (sameGroup.at(-1) ?? elements.at(-1)).node.end;
  return `${tsText.slice(0, after)},\n  ${entryText(entry)}${tsText.slice(after)}`;
}

/** Replace an entry's label and group in place. */
export function updateRegistryEntry(tsText, id, { label, group }) {
  const { fields } = registryElement(tsText, id);
  // Later positions first, so the earlier splice's offsets still hold.
  const edits = [[fields.label, label], [fields.group, group]]
    .sort(([a], [b]) => b.getStart() - a.getStart());
  let text = tsText;
  for (const [node, value] of edits) {
    text = `${text.slice(0, node.getStart())}${JSON.stringify(value)}${text.slice(node.end)}`;
  }
  return text;
}

/** Remove an entry with its line and its trailing comma. */
export function removeRegistryEntry(tsText, id) {
  const { node } = registryElement(tsText, id);
  const end = tsText[node.end] === ',' ? node.end + 1 : node.end;
  return `${tsText.slice(0, node.getFullStart())}${tsText.slice(end)}`;
}
