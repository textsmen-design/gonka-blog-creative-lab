#!/usr/bin/env python3
"""GONKA.BLOG — Этап 1: извлечение контента в src/data/*.json.

Стратегия: whitespaces берутся из БАЗОВОГО dist/index.html (Astro схлопывает
статические пробелы), поэтому публичный HTML остаётся байт-в-байт.
"""
import json, re, sys, os, collections

ROOT = '/Users/macbook/Desktop/GONKA-BLOG-CREATIVE-LAB'
COMPONENT = os.path.join(ROOT, 'src/components/SpatialWorkbench.astro')
INDEX = os.path.join(ROOT, 'src/pages/index.astro')
DATA_DIR = os.path.join(ROOT, 'src/data')
BASELINE = ('/var/folders/zl/7mv8tjnn28lbsyp8y6q48hnr0000gn/T/opencode/'
            'gonka-baseline/index.html.before')
DRY = '--write' not in sys.argv

src = open(COMPONENT, encoding='utf-8').read()
base = open(BASELINE, encoding='utf-8').read()

anomalies = []
records = []       # text nodes, in source order
attr_repls = []    # href/src attribute replacements
skipped_amp = []
UNSAFE = '&<>"\''
def unsafe(v):
    return any(c in v for c in UNSAFE)
stats = collections.Counter()

def A(msg):
    anomalies.append(msg)

# ----------------------------------------------------------------- norm
CID = re.compile(r'\s+data-astro-cid-[a-z0-9]+')

def make_norm(text):
    norm_chars = []
    idx_map = []
    i = 0
    while i < len(text):
        m = CID.match(text, i)
        if m:
            i = m.end()
            continue
        norm_chars.append(text[i])
        idx_map.append(i)
        i += 1
    return ''.join(norm_chars), idx_map

base_norm, base_map = make_norm(base)

WS_CONST = {}   # ws string -> constant name (emitted as {W0}, ...)

def js_str(s):
    if not s:
        return ''
    if s not in WS_CONST:
        WS_CONST[s] = 'W%d' % len(WS_CONST)
    return '{' + WS_CONST[s] + '}'

def find_anchor(text, s):
    """Last opening tag before the text node + everything up to node start."""
    j = s
    while j > 0 and text[j - 1] in ' \t\n':
        j -= 1
    tags = list(re.finditer(r'<[a-zA-Z][^<>]*>', text[:j]))
    start = None
    for m in reversed(tags):
        if not m.group(0).startswith('</'):
            start = m.start()
            break
    if start is None:
        A('anchor not found at %d' % s)
        return '', s
    return text[start:j], j

def add_text(gname, expr, label, m, base_off, groups_map):
    v_raw = m.group(gname)
    if not v_raw.strip():
        return None
    if unsafe(v_raw):
        skipped_amp.append((label, ' '.join(v_raw.split())))
        return None
    s0, e0 = base_off + m.start(gname), base_off + m.end(gname)
    # expand to whitespace boundaries
    i = s0
    while i > 0 and src[i - 1] in ' \t\n':
        i -= 1
    if i > 0 and src[i - 1] not in '><':
        A('left-text %s: %r' % (label, src[i - 25:i]))
    j = e0
    while j < len(src) and src[j] in ' \t\n':
        j += 1
    if j < len(src) and src[j] not in '><':
        A('right-text %s: %r' % (label, src[j:j + 25]))
    anchor, _ = find_anchor(src, i)
    records.append({
        's': i, 'e': j, 'expr': expr, 'label': label,
        'value_src': v_raw.strip(), 'anchor': anchor,
    })
    stats['values'] += 1
    return v_raw.strip()

# ---------------------------------------------------------------- regions
M_HEADER_END = '  <!-- ЦЕНТРАЛЬНЫЙ СВЕТОВОЙ СТОЛ -->'
M_FOOTER = '  <!-- НИЖНЯЯ ПАНЕЛЬ РАМЫ ВЕРСТАКА (Точки связи и соцсети) -->'
M_PANELS = '  <!-- ВЫДВИЖНЫЕ ПРАВЫЕ ПАНЕЛИ (КРАТКИЕ ФАКТЫ, БЕЗ ВОДЫ И МАРКЕТИНГА) -->'
M_BACKDROP = '  <!-- БЭКДРОП ДЛЯ ЗАКРЫТИЯ ДОСЬЕ -->'
i_header = src.index(M_HEADER_END)
i_main = src.index(M_FOOTER)
i_panels = src.index(M_PANELS)
i_back = src.index(M_BACKDROP)
regions = {'header': (0, i_header), 'main': (i_header, i_main),
           'footer': (i_main, i_panels), 'panels': (i_panels, i_back)}

def sub_region(name, pat, fn, flags=0):
    a, b = regions[name]
    for m in re.finditer(pat, src[a:b], flags):
        fn(m, a)

# ============================================================ site.json
site = {"meta": {}, "topbar": {}, "footer": {}, "desk": {},
        "nav": [], "scrolls": {"sites": {}, "bots": {}, "author": {}},
        "chips": []}

def S_(path, value):
    node = site
    parts = path.split('.')
    for p in parts[:-1]:
        node = node.setdefault(p, {})
    node[parts[-1]] = value

def simple(name, pat, expr, key, flags=0):
    def fn(m, off):
        if add_text('v', expr, key, m, off, None) is not None:
            S_(key, m.group('v').strip())
    sub_region(name, pat, fn, flags)

simple('header', r'<span class="status-text">(?P<v>[^<]*)</span>', '{site.topbar.status}', 'topbar.status')
simple('header', r'<span>(?P<v>45°15\'N 19°51\'E)</span>', '{site.topbar.coords}', 'topbar.coords')
simple('header', r'<span>(?P<v>VIBE CODING)</span>', '{site.topbar.vibe}', 'topbar.vibe')
simple('header', r'<span class="brand-sub">(?P<v>[^<]*)</span>', '{site.topbar.brandSub}', 'topbar.brandSub')
simple('footer', r'<span class="hint-sub">(?P<v>[^<]*)</span>', '{site.footer.hint}', 'footer.hint')

def handle_float_labels(m, off):
    block, start = m.group(0), off + m.start()
    tgt = re.findall(r'data-target="([^"]+)"', src[:start])
    target = tgt[-1] if tgt else 'unknown'
    for sub in re.finditer(r'<span class="(?:editorial-tag|parchment-tag)[^"]*">(?P<v>[^<]*)</span>', block):
        key = 'desk.%s.tag' % target
        rec = records.__class__  # noop
        i0 = start + sub.start('v')
        # route through add_text manually (group offsets are local)
        class _M:
            def group(self, g): return sub.group('v')
            def start(self, g): return sub.start('v')
            def end(self, g): return sub.end('v')
        if add_text('v', "{site.desk['%s'].tag}" % target, key, _M(), start, None) is not None:
            site['desk'].setdefault(target, {})['tag'] = sub.group('v').strip()
    for sub in re.finditer(r'<span class="(?:editorial-statement|parchment-statement)">(?P<v>[^<]*)</span>', block):
        key = 'desk.%s.statement' % target
        class _M:
            def group(self, g): return sub.group('v')
            def start(self, g): return sub.start('v')
            def end(self, g): return sub.end('v')
        if add_text('v', "{site.desk['%s'].statement}" % target, key, _M(), start, None) is not None:
            site['desk'].setdefault(target, {})['statement'] = sub.group('v').strip()

sub_region('main', r'<div class="editorial-float-label[^"]*">.*?</div>', handle_float_labels, re.S)

SCROLL = [
    (r'<div class="sites-closed-tag">\s*<span>(?P<v>[^<]*)</span>', '{site.scrolls.sites.closedTag}', 'scrolls.sites.closedTag'),
    (r'<span class="sites-parchment-tag">(?P<v>[^<]*)</span>', '{site.scrolls.sites.tag}', 'scrolls.sites.tag'),
    (r'<span class="sites-parchment-badge">(?P<v>[^<]*)</span>', '{site.scrolls.sites.badge}', 'scrolls.sites.badge'),
    (r'<div class="bots-closed-tag">\s*<span>(?P<v>[^<]*)</span>', '{site.scrolls.bots.closedTag}', 'scrolls.bots.closedTag'),
    (r'<div class="scroll-closed-tag">\s*<span>(?P<v>[^<]*)</span>', '{site.scrolls.author.closedTag}', 'scrolls.author.closedTag'),
    (r'<div class="sites-parchment-sub">(?P<v>[^<>]*?)<span class="sites-arrow">', '{site.scrolls.sites.sub}', 'scrolls.sites.sub'),
]
for pat, expr, key in SCROLL:
    def fn(m, off, expr=expr, key=key):
        if add_text('v', expr, key, m, off, None) is not None:
            S_(key, m.group('v').strip())
    sub_region('main', pat, fn)

def handle_nav(m, off):
    idx = len(site['nav'])
    v = add_text('v', '{site.nav[%d].label}' % idx, 'nav[%d]' % idx, m, off, None)
    if v is not None:
        site['nav'].append({'label': v})
sub_region('main', r'<span class="cabinet-nav-label">(?P<v>[^<]*)</span>', handle_nav)

def handle_chip(m, off):
    idx = len(site['chips'])
    v = add_text('v', '{site.chips[%d]}' % idx, 'chips[%d]' % idx, m, off, None)
    if v is not None:
        site['chips'].append(v)
sub_region('main', r'<span class="chip-label">(?P<v>[^<]*)</span>', handle_chip)

# ============================================================ sections
DRAWER_PATTERNS = [
    ('gt',      r'<span class="drawer-tag [^"]*">(?P<gt>[^<]*)</span>'),
    ('badge',   r'<span class="case-badge">(?P<badge>[^<]*)</span>'),
    ('status',  r'<div class="status-live[^"]*">(?P<status>[^<]*)</div>'),
    ('title',   r'<h2 class="case-title">(?P<title>[^<]*)</h2>'),
    ('lead',    r'<p class="case-lead">(?P<lead>[^<]*)</p>'),
    ('act',     r'<a\b[^>]*class="case-action-btn[^"]*"[^>]*>(?P<act>[^<>]*)</a>'),
    ('actbtn',  r'<button\b[^>]*class="case-action-btn[^"]*"[^>]*>(?P<actbtn>[^<>]*)</button>'),
    ('heading', r'<h3 class="section-heading">(?P<heading>[^<]*)</h3>'),
    ('stxt',    r'<p class="section-text">(?P<stxt>.*?)</p>'),
    ('li',      r'<li>(?P<li>[^<]*)</li>'),
    ('spec',    r'<div class="spec-row"><span>(?P<spl>[^<]*)</span><strong(?: class="[^"]*")?>(?P<spv>[^<]*)</strong></div>'),
    ('speclink', r'<div class="spec-row"><span>(?P<sl2>[^<]*)</span><strong><a\b[^>]*>(?P<sv2>[^<]*)</a></strong></div>'),
    ('tsbox',   r'<div class="tech-spec-box"[^>]*>(?P<tsbox>[^<]+)</div>'),
    ('res',     r'<div class="result-status-box">(?P<res>.*?)</div>'),
    ('quote',   r'<blockquote class="quote-box">(?P<quote>.*?)</blockquote>'),
    ('dtxt',    r'<p class="dossier-text">(?P<dtxt>.*?)</p>'),
    ('greet',   r'<div class="author-greeting">(?P<greet>[^<]*)</div>'),
    ('dsub',    r'<span class="dossier-subheading">(?P<dsub>[^<]*)</span>'),
    ('dtag',    r'<span class="dossier-tag">(?P<dtag>[^<]*)</span>'),
    ('dstat',   r'<span class="dossier-status">(?P<dstat>[^<]*)</span>'),
    ('cap',     r'<div class="dossier-screen-caption">\s*<span class="caption-dot">●</span>(?P<cap>[^<]*)</div>'),
    ('ftitle',  r'<div class="failure-title">(?P<ftitle>[^<]*)</div>'),
    ('fdesc',   r'<p class="failure-desc">(?P<fdesc>.*?)</p>'),
    ('rnum',    r'<span class="rule-num">(?P<rnum>[^<]*)</span>'),
    ('rtitle',  r'<div class="rule-content">\s*<strong>(?P<rtitle>[^<]*)</strong>'),
    ('rtext',   r'<p>(?P<rtext>[^<]*)</p>'),
    ('seal',    r'<span class="seal-text">(?P<seal>[^<]*)</span>'),
    ('stag',    r'<span class="scroll-tag">(?P<stag>[^<]*)</span>'),
    ('squote',  r'<blockquote class="scroll-handwritten-text">(?P<squote>.*?)</blockquote>'),
    ('geo',     r'<span class="artifact-geo">(?P<geo>[^<]*)</span>'),
    ('sig',     r'<span class="artifact-signature">(?P<sig>[^<]*)</span>'),
    ('curl',    r'<span class="screen-url-badge">(?P<curl>[^<]*)</span>'),
    ('cname',   r'<span class="catalog-project-name">\s*(?:<span class="tracker-led-mini"></span>\s*)?(?P<cname>[^<]*)</span>'),
    ('cbadge',  r'<span class="catalog-badge [^"]*">(?P<cbadge>[^<]*)</span>'),
    ('cdesc',   r'<p class="catalog-project-desc">(?P<cdesc>[^<]*)</p>'),
    ('cbtitle', r'<span class="catalog-block-title">(?P<cbtitle>[^<]*)</span>'),
    ('cbtext',  r'<p class="catalog-block-text">(?P<cbtext>[^<]*)</p>'),
    ('copen',   r'<button type="button" class="catalog-open-btn"[^>]*>(?P<copen>[^<>]*)</button>'),
    ('clink',   r'<a\b[^>]*class="catalog-link-btn"[^>]*>(?P<clink>[^<>]*)</a>'),
]
COMBINED = re.compile('|'.join('(?:%s)' % p for _, p in DRAWER_PATTERNS), re.S)
G2KEY = {}
for key, p in DRAWER_PATTERNS:
    for g in re.compile(p).groupindex:
        G2KEY[g] = key
        if g.startswith('sp') or g.startswith('sl') or g.startswith('sv'):
            pass
# spec pair group names
SPEC_L = {'spl', 'sl2'}
SPEC_V = {'spv', 'sv2'}

sections = {}
ASIDE_RE = re.compile(r'<aside id="(modal-[a-z0-9-]+)"[^>]*>(.*?)</aside>', re.S)
aside_iter = list(ASIDE_RE.finditer(src, i_panels, i_back))
stats['asides'] = len(aside_iter)

for am in aside_iter:
    did = am.group(1)
    a0 = am.start(2)
    body = am.group(2)
    drawer = {"header": {}, "hero": {}, "actions": []}
    sections[did] = drawer
    blocks = drawer.setdefault('blocks', [])
    cur_i = -1
    card_i = -1
    csec_i = -1
    fail_i = -1
    rule_i = -1

    for m in COMBINED.finditer(body):
        kind = G2KEY[m.lastgroup] if m.lastgroup in G2KEY else m.lastgroup
        off = a0
        BLOCK_K = {'stxt','tsbox','spec','speclink','res','quote','dtxt','greet',
                   'dsub','dtag','dstat','seal','stag','squote','geo','sig'}
        CARD_K = {'cname','cbadge','cdesc','cbtitle','cbtext','copen','clink'}
        if kind in BLOCK_K and cur_i < 0:
            A('%s: %s outside block' % (did, kind)); continue
        if kind in CARD_K and card_i < 0:
            A('%s: %s outside card' % (did, kind)); continue
        if kind in {'cbtext','copen','clink'} and csec_i < 0 and kind == 'cbtext':
            A('%s: %s outside card section' % (did, kind)); continue

        def E(gname, expr, label):
            return add_text(gname, expr, label, m, off, None)

        def setd(key, val):
            drawer[key] = val

        if kind == 'gt':
            v = E('gt', "{S[%r].header.tag}" % did, '%s.header.tag' % did)
            if v: drawer['header']['tag'] = v
        elif kind == 'badge':
            v = E('badge', "{S[%r].header.badge}" % did, '%s.header.badge' % did)
            if v: drawer['header']['badge'] = v
        elif kind == 'status':
            v = E('status', "{S[%r].hero.status}" % did, '%s.hero.status' % did)
            if v: drawer['hero']['status'] = v
        elif kind == 'title':
            v = E('title', "{S[%r].hero.title}" % did, '%s.hero.title' % did)
            if v: drawer['hero']['title'] = v
        elif kind == 'lead':
            v = E('lead', "{S[%r].hero.lead}" % did, '%s.hero.lead' % did)
            if v: drawer['hero']['lead'] = v
        elif kind in ('act', 'actbtn'):
            g = kind
            idx = len(drawer['actions'])
            v = E(g, "{S[%r].actions[%d]}" % (did, idx), '%s.actions[%d]' % (did, idx))
            if v is not None:
                drawer['actions'].append(v)
        elif kind == 'heading':
            v = E('heading', "{S[%r].blocks[%d].heading}" % (did, len(blocks)), '%s.blocks[%d].heading' % (did, len(blocks)))
            blocks.append({"heading": v} if v is not None else {})
            cur_i = len(blocks) - 1
            card_i = csec_i = -1
        elif kind == 'stxt':
            if cur_i < 0:
                A('%s: section-text without block' % did); continue
            v = E('stxt', "{S[%r].blocks[%d].text}" % (did, cur_i), '%s.blocks[%d].text' % (did, cur_i))
            if v is not None:
                blocks[cur_i]['text'] = v
        elif kind == 'li':
            if csec_i >= 0:
                card = drawer['cards'][card_i]; sec = card['sections'][csec_i]
                idx = len(sec.setdefault('items', []))
                v = E('li', "{S[%r].cards[%d].sections[%d].items[%d]}" % (did, card_i, csec_i, idx),
                      '%s.cards[%d].items[%d]' % (did, card_i, idx))
                if v is not None: sec['items'].append(v)
            elif cur_i >= 0:
                idx = len(blocks[cur_i].setdefault('items', []))
                v = E('li', "{S[%r].blocks[%d].items[%d]}" % (did, cur_i, idx), '%s.items[%d]' % (did, idx))
                if v is not None: blocks[cur_i]['items'].append(v)
            else:
                A('%s: <li> outside block' % did)
        elif kind in ('spec', 'speclink'):
            if cur_i < 0:
                A('%s: spec without block' % did); continue
            blk = blocks[cur_i]
            idx = len(blk.setdefault('specs', []))
            gl, gv = ('spl', 'spv') if kind == 'spec' else ('sl2', 'sv2')
            if unsafe(m.group(gl)) or unsafe(m.group(gv)):
                for g_ in (gl, gv):
                    if unsafe(m.group(g_)):
                        skipped_amp.append(('%s.spec (%s)' % (did, g_), ' '.join(m.group(g_).split())))
                continue
            v1 = E(gl, "{S[%r].blocks[%d].specs[%d][0]}" % (did, cur_i, idx), '%s.spec-l' % did)
            v2 = E(gv, "{S[%r].blocks[%d].specs[%d][1]}" % (did, cur_i, idx), '%s.spec-v' % did)
            if v1 is not None and v2 is not None:
                blk['specs'].append([v1, v2])
        elif kind == 'tsbox':
            v = E('tsbox', "{S[%r].blocks[%d].boxText}" % (did, cur_i), '%s.boxText' % did)
            if v is not None: blocks[cur_i]['boxText'] = v
        elif kind == 'res':
            v = E('res', "{S[%r].blocks[%d].result}" % (did, cur_i), '%s.result' % did)
            if v is not None: blocks[cur_i]['result'] = v
        elif kind == 'quote':
            v = E('quote', "{S[%r].blocks[%d].quote}" % (did, cur_i), '%s.quote' % did)
            if v is not None: blocks[cur_i]['quote'] = v
        elif kind == 'dtxt':
            idx = len(blocks[cur_i].setdefault('dossier', []))
            v = E('dtxt', "{S[%r].blocks[%d].dossier[%d]}" % (did, cur_i, idx), '%s.dossier[%d]' % (did, idx))
            if v is not None: blocks[cur_i]['dossier'].append(v)
        elif kind == 'greet':
            v = E('greet', "{S[%r].blocks[%d].greeting}" % (did, cur_i), '%s.greeting' % did)
            if v is not None: blocks[cur_i]['greeting'] = v
        elif kind == 'dsub':
            idx = len(blocks[cur_i].setdefault('subheadings', []))
            v = E('dsub', "{S[%r].blocks[%d].subheadings[%d]}" % (did, cur_i, idx), '%s.subheading[%d]' % (did, idx))
            if v is not None: blocks[cur_i]['subheadings'].append(v)
        elif kind == 'dtag':
            v = E('dtag', "{S[%r].blocks[%d].dossierTag}" % (did, cur_i), '%s.dossierTag' % did)
            if v is not None: blocks[cur_i]['dossierTag'] = v
        elif kind == 'dstat':
            v = E('dstat', "{S[%r].blocks[%d].dossierStatus}" % (did, cur_i), '%s.dossierStatus' % did)
            if v is not None: blocks[cur_i]['dossierStatus'] = v
        elif kind == 'cap':
            v = E('cap', "{S[%r].screen.caption}" % did, '%s.screen.caption' % did)
            if v is not None: drawer.setdefault('screen', {})['caption'] = v
        elif kind == 'ftitle':
            fail_i = len(drawer.setdefault('failures', []))
            v = E('ftitle', "{S[%r].failures[%d].title}" % (did, fail_i), '%s.failure.title' % did)
            drawer['failures'].append({})
            if v is not None: drawer['failures'][fail_i]['title'] = v
        elif kind == 'fdesc':
            v = E('fdesc', "{S[%r].failures[%d].desc}" % (did, fail_i), '%s.failure.desc' % did)
            if v is not None: drawer['failures'][fail_i]['desc'] = v
        elif kind == 'rnum':
            rule_i = len(drawer.setdefault('rules', []))
            drawer['rules'].append({})
            v = E('rnum', "{S[%r].rules[%d].num}" % (did, rule_i), '%s.rule.num' % did)
            if v is not None: drawer['rules'][rule_i]['num'] = v
        elif kind == 'rtitle':
            v = E('rtitle', "{S[%r].rules[%d].title}" % (did, rule_i), '%s.rule.title' % did)
            if v is not None: drawer['rules'][rule_i]['title'] = v
        elif kind == 'rtext':
            v = E('rtext', "{S[%r].rules[%d].text}" % (did, rule_i), '%s.rule.text' % did)
            if v is not None: drawer['rules'][rule_i]['text'] = v
        elif kind == 'seal':
            v = E('seal', "{S[%r].blocks[%d].seal}" % (did, cur_i), '%s.seal' % did)
            if v is not None: blocks[cur_i]['seal'] = v
        elif kind == 'stag':
            v = E('stag', "{S[%r].blocks[%d].tag}" % (did, cur_i), '%s.artifactTag' % did)
            if v is not None: blocks[cur_i]['tag'] = v
        elif kind == 'squote':
            v = E('squote', "{S[%r].blocks[%d].quote}" % (did, cur_i), '%s.artifactQuote' % did)
            if v is not None: blocks[cur_i]['quote'] = v
        elif kind == 'geo':
            v = E('geo', "{S[%r].blocks[%d].geo}" % (did, cur_i), '%s.geo' % did)
            if v is not None: blocks[cur_i]['geo'] = v
        elif kind == 'sig':
            v = E('sig', "{S[%r].blocks[%d].signature}" % (did, cur_i), '%s.signature' % did)
            if v is not None: blocks[cur_i]['signature'] = v
        elif kind == 'curl':
            cards = drawer.setdefault('cards', [])
            cards.append({"sections": [], "actions": []})
            card_i = len(cards) - 1
            csec_i = cur_i = -1
            v = E('curl', "{S[%r].cards[%d].screenBadge}" % (did, card_i), '%s.card.screenBadge' % did)
            if v is not None: cards[card_i]['screenBadge'] = v
        elif kind == 'cname':
            v = E('cname', "{S[%r].cards[%d].name}" % (did, card_i), '%s.card.name' % did)
            if v is not None: drawer['cards'][card_i]['name'] = v
        elif kind == 'cbadge':
            v = E('cbadge', "{S[%r].cards[%d].badge}" % (did, card_i), '%s.card.badge' % did)
            if v is not None: drawer['cards'][card_i]['badge'] = v
        elif kind == 'cdesc':
            v = E('cdesc', "{S[%r].cards[%d].desc}" % (did, card_i), '%s.card.desc' % did)
            if v is not None: drawer['cards'][card_i]['desc'] = v
        elif kind == 'cbtitle':
            card = drawer['cards'][card_i]
            card['sections'].append({})
            csec_i = len(card['sections']) - 1
            v = E('cbtitle', "{S[%r].cards[%d].sections[%d].title}" % (did, card_i, csec_i),
                  '%s.card.sec.title' % did)
            if v is not None: card['sections'][csec_i]['title'] = v
        elif kind == 'cbtext':
            v = E('cbtext', "{S[%r].cards[%d].sections[%d].text}" % (did, card_i, csec_i),
                  '%s.card.sec.text' % did)
            if v is not None: drawer['cards'][card_i]['sections'][csec_i]['text'] = v
        elif kind == 'copen':
            card = drawer['cards'][card_i]
            v = E('copen', "{S[%r].cards[%d].actions[%d]}" % (did, card_i, len(card['actions'])),
                  '%s.card.action' % did)
            if v is not None: card['actions'].append(v)
        elif kind == 'clink':
            card = drawer['cards'][card_i]
            v = E('clink', "{S[%r].cards[%d].actions[%d]}" % (did, card_i, len(card['actions'])),
                  '%s.card.action' % did)
            if v is not None: card['actions'].append(v)
        else:
            A('unhandled group %r in %s' % (m.lastgroup, did))

# ============================================================ href/src
LINKS = [
    ('telegram', 'https://t.me/lonelysvobodny'),
    ('email', 'mailto:textsmen@gmail.com'),
    ('youtube', '#youtube'),
    ('instagram', '#instagram'),
    ('english', 'https://english.gonka.blog'),
    ('twohearts', 'https://twohearts.gonka.blog'),
    ('siteviza', 'https://siteviza.gonka.blog'),
    ('atelier', 'https://atelier.gonka.blog'),
    ('landasset5', 'https://landasset5.gonka.blog'),
    ('tracker01', 'https://tracker-01.gonka.blog/'),
    ('reloca', 'https://reloca.gonka.blog/'),
    ('myasnayaTroitsa', 'https://t.me/myasnaya_troitsa_bot'),
    ('botDetective', 'https://t.me/AI_CH_BOT_univers_bot'),
]
links = {k: u for k, u in LINKS}
media = {"previews": {}}
MEDIA_MAP = {
    'englishTeacher': 'preview-english-teacher.jpg',
    'twohearts': 'preview-twohearts.jpg',
    'siteviza': 'preview-siteviza.jpg',
    'atelier': 'preview-atelier.jpg',
    'landasset5': 'preview-landasset5.jpg',
    'tracker01': 'preview-tracker01.jpg',
    'myasnayaTroitsa': 'preview-myasnaya-troitsa.png',
    'botDetective': 'preview-bot-detective.png',
}
for k, f in MEDIA_MAP.items():
    media['previews'][k] = '/previews/' + f

def attr_pass(needle, repl, label):
    pos = 0
    n = 0
    while True:
        k = src.find(needle, pos)
        if k < 0:
            break
        attr_repls.append((k, k + len(needle), repl))
        pos = k + len(needle)
        n += 1
    stats[label] = n
    if needle not in base:
        A('baseline lacks %r' % needle)

for k, u in LINKS:
    attr_pass('href="%s"' % u, 'href={L.%s}' % k, 'href:' + k)
for k, f in MEDIA_MAP.items():
    attr_pass('src="/previews/%s"' % f, 'src={M.%s}' % k, 'img:' + k)

# ============================================================ baseline ws
def resolve_ws():
    cursor = 0
    resolved = []
    for rec in records:
        anchor_n = CID.sub('', rec['anchor'])
        val = rec['value_src']
        pat = (re.escape(anchor_n) + r'[ \t\n]*(?P<val>' + re.escape(val) + r')([ \t\n]*)')
        m = re.compile(pat).search(base_norm, cursor)
        if not m:
            # try collapsed variants of the value
            found = None
            for variant in (
                re.sub(r'[ \t]*\n[ \t]*', '\n', val),
                re.sub(r'\n[ \t]*', '\n', val),
                re.sub(r'[ \t]+', ' ', val),
                re.sub(r'\s+', ' ', val),
            ):
                if variant == val:
                    continue
                m2 = re.compile(re.escape(anchor_n) + r'[ \t\n]*(?P<val>' + re.escape(variant) + r')([ \t\n]*)')\
                    .search(base_norm, cursor)
                if m2:
                    found = (m2, variant)
                    break
            if not found:
                A('NOT FOUND in baseline: %s | anchor=%r value=%r'
                  % (rec['label'], rec['anchor'][-60:], val[:70]))
                resolved.append(None)
                continue
            m, variant = found
            A('value collapsed in baseline: %s | src=%r -> out=%r'
              % (rec['label'], val, variant))
            rec['value_out'] = variant
        else:
            rec['value_out'] = val
        # original positions of value
        vs, ve = m.start('val'), m.end('val')
        os_, oe = base_map[vs], base_map[ve - 1] + 1
        rendered = base[os_:oe]
        rec['value_out'] = rendered
        if rendered != rec['value_src'].strip():
            A('value_out mismatch %s: src=%r out=%r' % (rec['label'], rec['value_src'].strip(), rendered))
        if '<' in rendered:
            A('value contains markup %s: %r' % (rec['label'], rendered[:80]))
        # whitespace around, from ORIGINAL baseline
        i = os_
        while i > 0 and base[i - 1] in ' \t\n':
            i -= 1
        j = oe
        while j < len(base) and base[j] in ' \t\n':
            j += 1
        rec['ws1'] = base[i:os_]
        rec['ws2'] = base[oe:j]
        cursor = ve
        resolved.append(rec)
    return resolved

records.sort(key=lambda r: r['s'])
resolved = resolve_ws()

# ============================================================ apply
repls = []
for rec, r in zip(records, resolved):
    if r is None:
        continue
    new = js_str(r['ws1']) + r['expr'] + js_str(r['ws2'])
    repls.append((r['s'], r['e'], new, r['label']))
for a, b, c in attr_repls:
    repls.append((a, b, c, 'attr'))

repls.sort(key=lambda x: x[0])
for x, y in zip(repls, repls[1:]):
    if x[1] > y[0]:
        A('OVERLAP %r .. %r' % (x, y))

out = []
prev = 0
applied = 0
skipped = 0
for s, e, new, label in repls:
    if s < prev:
        skipped += 1
        continue
    out.append(src[prev:s])
    out.append(new)
    prev = e
    applied += 1
out.append(src[prev:])
new_src = ''.join(out)

# sanity
style_a = new_src.index('<style>')
style_b = new_src.index('</style>')
LEAK = ('{L.', '{S[', '{site.', '{M.', '{links.', '{media.')
if any(t in new_src[style_a:style_b] for t in LEAK):
    A('expression leaked into <style>')
script_a = new_src.index('<script>')
script_b = new_src.index('</script>', script_a)
if any(t in new_src[script_a:script_b] for t in LEAK):
    A('expression leaked into <script>')

# ============================================================ report
print('records(text nodes):', len(records), '| applied:', applied, '| attr:', len(attr_repls),
      '| skipped-overlap:', skipped)
print('asides:', stats['asides'])
print('href counts:', {k: v for k, v in stats.items() if k.startswith('href:')})
print('img counts:', {k: v for k, v in stats.items() if k.startswith('img:')})
print('spec rows extracted:', sum(1 for r in records if r['label'].endswith('.spec-v')),
      '/ spec-row in src:', src.count('<div class="spec-row">'))
print('li extracted:', sum(1 for r in records if '.items[' in r['label']))
print('ws constants:', len(WS_CONST))
print('anomalies:', len(anomalies))
for a in anomalies:
    print('  !', a)
print('skipped (HTML-escaped chars &\'\"<>):', len(skipped_amp))
for s in skipped_amp:
    print('  ~', s)


# ---- uncovered text nodes (report only) ----
end_mk = src.index('<style>')
covered = [(r['s'], r['e']) for r in records]
attr_spans = [(a, b) for a, b, _ in attr_repls]
unc = []
for m in re.finditer(r'>([^<>]+)<', src[:end_mk]):
    t = m.group(1)
    if not t.strip():
        continue
    a, b = m.start(1), m.end(1)
    if any(a < be and b > af for af, be in covered + attr_spans):
        continue
    unc.append((a, ' '.join(t.split())[:70]))
print('uncovered text nodes:', len(unc))
for pos, t in unc:
    print('   @%-6d %s' % (pos, t))

if DRY:
    print('\n--- DRY RUN ---')
    sys.exit(0 if not anomalies else 1)

os.makedirs(DATA_DIR, exist_ok=True)
open(COMPONENT, 'w', encoding='utf-8').write(new_src)

idx = open(INDEX, encoding='utf-8').read()
site['meta']['title'] = re.search(r'const title = "([^"]*)";', idx).group(1)
site['meta']['description'] = re.search(r'const description = "([^"]*)";', idx).group(1)

ws_lines = ['const %s = %s;' % (name, json.dumps(val, ensure_ascii=False))
            for val, name in sorted(WS_CONST.items(), key=lambda kv: kv[1])]
FM = ('---\n// src/components/SpatialWorkbench.astro\n'
      "import site from '../data/site.json';\n"
      "import links from '../data/links.json';\n"
      "import media from '../data/media.json';\n"
      "import sections from '../data/sections.json';\n\n"
      'const S = sections;\nconst L = links;\nconst M = media.previews;\n'
      + '\n'.join(ws_lines) + '\n---')
old_fm = '---\n// src/components/SpatialWorkbench.astro\n---'
assert new_src.startswith(old_fm), 'frontmatter mismatch'
final_src = FM + new_src[len(old_fm):]
open(COMPONENT, 'w', encoding='utf-8').write(final_src)

idx_new = idx.replace('const title = "GONKA.BLOG — Личная цифровая лаборатория";',
                      "import site from '../data/site.json';\n\nconst title = site.meta.title;", 1)
idx_new = idx_new.replace(
    'const description = "Среда, где идеи превращаются в работающие цифровые продукты: сайты, боты, AI-сервисы, автоматизации и SaaS.";',
    'const description = site.meta.description;', 1)
assert 'site.meta.title' in idx_new and 'site.meta.description' in idx_new
open(INDEX, 'w', encoding='utf-8').write(idx_new)

def dump(name, obj):
    with open(os.path.join(DATA_DIR, name), 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.write('\n')

dump('site.json', site)
dump('links.json', links)
dump('media.json', media)
dump('sections.json', sections)
print('\nwritten: src/data/{site,links,media,sections}.json, component, index.astro')
