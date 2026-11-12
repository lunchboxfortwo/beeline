import ts from 'typescript';

/** One glyph per concept. Provider marks and identity/drawing art are separate. */
export const CONCEPT_ICONS = {
  thread: 'CornerDownRight', chat: 'Hash', message: 'MessagesSquare',
  warning: 'AlertTriangle', archive: 'Archive', down: 'ArrowDown', back: 'ArrowLeft',
  forward: 'ArrowRight', up: 'ArrowUp', mention: 'AtSign', audio: 'AudioLines',
  bookmark: 'Bookmark', agent: 'Bot', selected: 'Check', expand: 'ChevronDown',
  previous: 'ChevronLeft', next: 'ChevronRight', contract: 'ChevronUp',
  clipboard: 'Clipboard', copy: 'Copy', reply: 'CornerUpLeft', download: 'Download',
  external: 'ExternalLink', document: 'FileText', file: 'File', codeFile: 'FileCode', pullRequest: 'GitPullRequest',
  public: 'Globe', image: 'Image', keyboard: 'Keyboard', link: 'Link', private: 'Lock',
  signOut: 'LogOut', email: 'Mail', maximize: 'Maximize2', microphone: 'Mic',
  mutedMicrophone: 'MicOff', subtract: 'Minus', overflow: 'MoreHorizontal', edit: 'Pencil',
  pin: 'Pin', run: 'Play', connect: 'Plug', add: 'Plus', refresh: 'RefreshCw',
  search: 'Search', settings: 'Settings', share: 'Share2', slash: 'Slash',
  intelligence: 'Sparkles', stop: 'Square', command: 'Terminal', disconnect: 'Unplug',
  invite: 'UserPlus', people: 'Users', workflow: 'Workflow', close: 'X',
};
const LUCIDE_ICONS = new Set(Object.values(CONCEPT_ICONS));
const CONCEPT_COMPONENTS = {
  ChatMark: 'chat', RepositoryMark: 'chat', ScheduledWorkWhere: 'thread',
  RepositoryLifecycleRow: 'thread', ThreadLine: 'thread',
};
// Existing drawn adapters. No new icon module or alternate thread/chat mark.
const LOCAL_ICONS = {
  ChevronGlyph: new Set(['ChevronGlyph', 'CHEVRON_ROW_SIZE', 'CHEVRON_BACK_SIZE']),
  CloseGlyph: new Set(['CloseButton']),
  ExternalGlyph: new Set(['ExternalGlyph']),
  MicGlyph: new Set(['ConversationGlyph', 'COMPOSER_GLYPH_SIZE']),
  PinGlyph: new Set(['PinGlyph']),
  'wallet-icons': new Set(['chainIcon', 'tokenIcon']),
  'decorative-glyph': new Set(['DECORATIVE_GLYPH_PROPS']),
  'beeline-glyph': new Set(['MARK_CELL', 'SURFACE_GLYPH_SIZE', 'GLYPH_STROKE', 'SPLASH_PAINT_MS', 'RELEASE_PAINT_MS', 'RELEASE_UNWIND_MS', 'RELEASE_REST_MS', 'GLYPH_PAINT', 'glyphPaintInk', 'ribbon', 'glyphViewBox']),
  grammar: new Set(['Glyph', 'EmojiGlyph']),
  ComposerChrome: new Set(['ComposerGlyph']),
  Suggestions: new Set(['SuggestionGlyph']),
};

/** Fixed primary roles; EmptyState's existing secondary description stays meta. */
export const STATUS_ROLES = {
  RoomDeckLoadingView: 'meta', ChatOpeningSurface: 'meta', ConnectorLoading: 'meta',
  ConnectorNote: 'meta', ViewerPlaceholder: 'meta', EmptyState: 'body',
};
const CONTROLS = new Set(['Btn', 'Button', 'ListItem', 'SheetRow', 'Row']);
const LAYOUTS = new Set(['YStack', 'XStack', 'View', 'ScrollView', 'SignInCenter']);
const ICON_MODULE = /lucide|vector-icons|iconify|phosphor|heroicons|feather|(?:^|\/)(?:icons?|glyphs?)(?:\/|$)|(?:^|\/)[^/]*[Gg]lyph(?:\.[jt]sx?)?$|(?:^|\/)[^/]*icons(?:\.[jt]sx?)?$/;
const moduleBase = from => from.split('/').at(-1).replace(/\.[jt]sx?$/, '');
const opening = node => ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : undefined;
function attr(node, name) {
  return node.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.getText() === name);
}
function value(attribute) {
  if (!attribute) return undefined;
  if (!attribute.initializer) return true;
  let expr = attribute.initializer;
  if (ts.isJsxExpression(expr)) expr = expr.expression;
  if (expr && ts.isStringLiteral(expr)) return expr.text;
  if (expr?.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expr?.kind === ts.SyntaxKind.FalseKeyword) return false;
  return null;
}

/** Component identities and syntax determine roles, never visible copy. */
export function scanVisualSource(file, source) {
  const errors = [], names = new Map(), ionicons = new Set(), judged = new Set();
  const nameOf = node => names.get(node.tagName.getText()) ?? node.tagName.getText();
  const emit = (node, rule, message) => errors.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, rule, message });
  const checkImport = (node, from, bindings, defaultName, namespace) => {
    if (!ICON_MODULE.test(from)) {
      bindings = bindings.filter(name => /(?:Icon|Glyph)$/.test(name));
      if (!bindings.length && !/(?:Icon|Glyph)$/.test(defaultName ?? '')) return;
    }
    const base = moduleBase(from);
    if (from === 'lucide-react-native' && !defaultName && !namespace) {
      for (const binding of bindings) if (!LUCIDE_ICONS.has(binding)) emit(node, 'glyph-lock', `${binding} is not an approved concept icon`);
    } else if (from === '@expo/vector-icons/Ionicons' && defaultName && !namespace && !bindings.length) {
      ionicons.add(defaultName);
    } else if (LOCAL_ICONS[base] && !defaultName && !namespace) {
      for (const binding of bindings) if (!LOCAL_ICONS[base].has(binding)) emit(node, 'glyph-lock', `${binding} is not an approved icon adapter`);
    } else emit(node, 'glyph-lock', `${from} is not an approved icon import; threads use CornerDownRight and chats use Hash`);
  };
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue;
    const clause = statement.importClause, from = statement.moduleSpecifier.text;
    const bindings = clause?.namedBindings;
    const items = bindings && ts.isNamedImports(bindings) ? bindings.elements.filter(e => !e.isTypeOnly) : [];
    for (const item of items) names.set(item.name.text, (item.propertyName ?? item.name).text);
    checkImport(statement, from, items.map(e => (e.propertyName ?? e.name).text), clause?.name?.text, bindings && ts.isNamespaceImport(bindings));
  }
  if (['CornerGlyph', 'RoomGlyph'].includes(moduleBase(file))) emit(source, 'glyph-lock', 'The retired corner/chat mark must be deleted');

  const checkText = (node, role) => {
    const tag = opening(node);
    if (!tag || judged.has(node)) return;
    const name = nameOf(tag);
    if (!['T', 'Copy', 'Text'].includes(name)) return;
    judged.add(node);
    let expected = role;
    // The two slots of the shared empty state keep their existing sizes.
    if (role === 'body' && ts.isJsxElement(node) && node.children.some(c => ts.isJsxExpression(c) && ts.isIdentifier(c.expression ?? {}) && c.expression.text === 'description')) expected = 'meta';
    // A status's secondary note is the existing small Copy role.
    if (role === 'body' && name === 'Copy' && value(attr(tag, 'small')) === true) expected = 'meta';
    const variant = name === 'T' ? attr(tag, 'v') ? value(attr(tag, 'v')) : 'body'
      : name === 'Copy' ? value(attr(tag, 'strong')) === null || value(attr(tag, 'small')) === null ? 'dynamic'
        : value(attr(tag, 'strong')) ? 'strong' : value(attr(tag, 'small')) ? 'meta' : 'body' : 'raw';
    if (variant !== expected || tag.attributes.properties.some(ts.isJsxSpreadAttribute))
      emit(tag, 'role-lock', `This status slot uses the fixed ${expected} variant; headings and strong variants are not status copy`);
  };
  const walkRole = (node, role, owner = true) => {
    const tag = opening(node);
    if (tag) {
      const name = nameOf(tag);
      if (CONTROLS.has(name)) return;
      checkText(node, role);
      // A page's header or custom child component owns a different role.
      if (!owner && !LAYOUTS.has(name) && !['T', 'Copy'].includes(name)) return;
    }
    ts.forEachChild(node, child => walkRole(child, role, false));
  };
  const visit = node => {
    if (ts.isFunctionDeclaration(node) && node.name && STATUS_ROLES[node.name.text]) walkRole(node, STATUS_ROLES[node.name.text]);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && STATUS_ROLES[node.name.text] && node.initializer) walkRole(node.initializer, STATUS_ROLES[node.name.text]);
    // Concept owners must not borrow another icon that is approved for a different job.
    if (ts.isFunctionDeclaration(node) && CONCEPT_COMPONENTS[node.name?.text]) {
      const concept = CONCEPT_COMPONENTS[node.name.text];
      const checkConcept = child => {
        const tag = opening(child);
        if (tag && ['Glyph', 'Inked'].includes(nameOf(tag))) {
          const icon = attr(tag, nameOf(tag) === 'Glyph' ? 'icon' : 'glyph')?.initializer;
          const expr = icon && ts.isJsxExpression(icon) ? icon.expression : undefined;
          const name = expr && ts.isIdentifier(expr) ? names.get(expr.text) ?? expr.text : undefined;
          if (name !== CONCEPT_ICONS[concept])
            emit(tag, 'glyph-lock', `The ${concept} concept uses ${CONCEPT_ICONS[concept]}`);
        }
        ts.forEachChild(child, checkConcept);
      };
      checkConcept(node.body);
    }
    if (ts.isObjectLiteralExpression(node)) {
      const properties = node.properties.filter(ts.isPropertyAssignment);
      if (properties.some(p => p.name.getText() === 'value' && ts.isStringLiteral(p.initializer) && p.initializer.text === 'chats')) {
        const icon = properties.find(p => p.name.getText() === 'icon')?.initializer;
        if (icon && (!ts.isIdentifier(icon) || (names.get(icon.text) ?? icon.text) !== CONCEPT_ICONS.chat)) emit(icon, 'glyph-lock', 'The Chats tab uses Hash');
      }
    }
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const bindings = node.exportClause;
      checkImport(node, node.moduleSpecifier.text, bindings && ts.isNamedExports(bindings) ? bindings.elements.filter(e => !e.isTypeOnly).map(e => (e.propertyName ?? e.name).text) : [], undefined, !bindings || ts.isNamespaceExport(bindings));
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) && ts.isStringLiteral(node.arguments[0] ?? {})) {
      if (ICON_MODULE.test(node.arguments[0].text)) emit(node, 'glyph-lock', 'Icon imports must name approved symbols statically');
    }
    const tag = opening(node);
    if (tag) {
      const name = nameOf(tag);
      if (ionicons.has(tag.tagName.getText()) && value(attr(tag, 'name')) !== 'time-outline') emit(tag, 'glyph-lock', 'The only existing Ionicons concept is time-outline');
      if (STATUS_ROLES[name]) walkRole(node, STATUS_ROLES[name]);
      if (ts.isJsxElement(node) && !CONTROLS.has(name)) {
        // Direct indicators identify the status container, not a word like "Loading".
        const indicators = node.children.map(opening).filter(Boolean).map(nameOf);
        if (indicators.includes('SurfaceGlyphLoader') || indicators.includes('Spinner')) walkRole(node, name === 'SignInCenter' ? 'body' : 'meta');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return errors;
}
