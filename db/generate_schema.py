import re, json, collections, io, os

src = open('/dev-server/src/integrations/supabase/types.ts').read()

# ---- isolate public.Tables block ----
start = src.index('    Tables: {')
end = src.index('\n    Views: {', start)
block = src[start:end]

lines = block.split('\n')
tables = collections.OrderedDict()
cur = None
section = None
rel_buf = None
i = 0
while i < len(lines):
    ln = lines[i]
    m = re.match(r'^      ([A-Za-z0-9_]+): \{$', ln)
    if m:
        cur = m.group(1)
        tables[cur] = {'cols': collections.OrderedDict(), 'fks': []}
        section = None
        i += 1
        continue
    if cur:
        m = re.match(r'^        (Row|Insert|Update|Relationships): ', ln)
        if m:
            section = m.group(1)
            if section == 'Relationships':
                if ln.rstrip().endswith('[]'):
                    i += 1
                    continue
                buf = [ln]
                j = i + 1
                while j < len(lines) and not re.match(r'^        \]', lines[j]):
                    buf.append(lines[j]); j += 1
                buf.append('        ]')
                txt = '\n'.join(buf)
                for obj in re.findall(r'\{(.*?)\}', txt, re.S):
                    nm = re.search(r'foreignKeyName: "(.*?)"', obj)
                    cs = re.search(r'columns: \[(.*?)\]', obj, re.S)
                    rt = re.search(r'referencedRelation: "(.*?)"', obj)
                    rc = re.search(r'referencedColumns: \[(.*?)\]', obj, re.S)
                    if not (nm and cs and rt and rc):
                        continue
                    tables[cur]['fks'].append({'name': nm.group(1), 'cols': re.findall(r'"(.*?)"', cs.group(1)), 'rtable': rt.group(1), 'rcols': re.findall(r'"(.*?)"', rc.group(1))})
                i = j + 1
                continue
            i += 1
            continue
        m = re.match(r'^          ([A-Za-z0-9_]+)(\??): (.+)$', ln)
        if m and section in ('Row', 'Insert'):
            name, opt, tsty = m.group(1), m.group(2) == '?', m.group(3).strip()
            if section == 'Row':
                nullable = '| null' in tsty
                base = tsty.replace('| null', '').strip()
                tables[cur]['cols'][name] = {'ts': base, 'nullable': nullable, 'optional': False}
            else:
                if name in tables[cur]['cols']:
                    tables[cur]['cols'][name]['optional'] = opt
            i += 1
            continue
    i += 1

# ---- defaults mined from the uploaded spec markdown ----
spec_defaults = {}
spec_path = '/mnt/user-uploads/complete_supabase_api_spec.md'
if os.path.exists(spec_path):
    tbl = None
    for ln in open(spec_path):
        m = re.match(r'^### [\d.]+ `([a-z0-9_]+)`', ln)
        if m:
            tbl = m.group(1); continue
        m = re.match(r'^\*\*`([a-z0-9_]+)`\*\*', ln)
        if m:
            tbl = m.group(1); continue
        if tbl and ln.startswith('|'):
            parts = [p.strip() for p in ln.strip().strip('|').split('|')]
            if len(parts) >= 4 and re.match(r'^[a-z0-9_]+$', parts[0]):
                d = parts[3]
                if d and d not in ('—', '-', ''):
                    spec_defaults[(tbl, parts[0])] = d

INT_HINTS = ('_count', 'count', 'quantity', 'stock', 'position', 'sort_order', 'display_order',
             '_days', '_seconds', '_minutes', '_hours', '_limit', 'attempts', 'max_', 'min_',
             '_index', 'priority', 'version', 'width', 'height', 'duration', 'retries', 'rating_count')
MONEY_HINTS = ('price', 'amount', 'total', 'cost', 'fee', 'discount', 'balance', 'rate', 'percent', 'tax', 'weight', 'lat', 'lng', 'longitude', 'latitude', 'score', 'rating')

uuid_cols = set()
for t, d in tables.items():
    for fk in d['fks']:
        for c, rc in zip(fk['cols'], fk['rcols']):
            if rc == 'id':
                uuid_cols.add((t, c))

UUID_NAMES = {'id', 'user_id', 'store_id', 'owner_id', 'created_by', 'updated_by', 'performed_by',
              'deleted_by', 'target_user_id', 'target_store_id', 'store_user_id', 'parent_id',
              'team_member_id', 'order_id', 'product_id', 'client_id', 'category_id', 'plan_id',
              'carrier_id', 'provider_id', 'bundle_id', 'subscription_id', 'shipment_id',
              'variant_id', 'option_id', 'review_id', 'integration_id', 'session_id', 'agent_id'}
TEXT_ID_NAMES = {'provider_order_id', 'external_id', 'tracking_id', 'transaction_id', 'payment_id',
                 'message_id', 'pixel_id', 'phone_number_id', 'waba_id', 'event_id', 'locality_id',
                 'gateway_id', 'reference_id'}

def pg_type(table, col, info):
    ts = info['ts']
    arr = ts.endswith('[]')
    b = ts[:-2] if arr else ts
    if b == 'Json':
        t = 'jsonb'
    elif b == 'boolean':
        t = 'boolean'
    elif b == 'number':
        low = col.lower()
        if any(h in low for h in MONEY_HINTS):
            t = 'numeric'
        elif any(h in low for h in INT_HINTS):
            t = 'integer'
        else:
            t = 'numeric'
    else:  # string
        low = col.lower()
        if (table, col) in uuid_cols or (col in UUID_NAMES and col not in TEXT_ID_NAMES):
            t = 'uuid'
        elif re.search(r'(^|_)(at)$', low) or low in ('created_at', 'updated_at'):
            t = 'timestamptz'
        elif low.endswith('_date') or low == 'date':
            t = 'date'
        elif low.endswith('_time') or low == 'time':
            t = 'time'
        else:
            t = 'text'
    return t + ('[]' if arr else '')

BAD_SPEC = {'pk', 'fk', 'uuid nullable', 'unique', 'text', 'jsonb', 'string', 'number', 'boolean', 'r', '?'}

def default_for(table, col, t, info):
    if col == 'id' and t == 'uuid':
        return 'gen_random_uuid()'
    spec = spec_defaults.get((table, col))
    if spec and (spec.strip('` ').lower() in BAD_SPEC or ' ' in spec.strip('` ').strip("'")):
        spec = None
    if spec:
        s = spec.strip('` ')
        sl = s.lower()
        if sl in ('null',):
            return None
        if sl in ('uuid', 'gen_random_uuid()'):
            return 'gen_random_uuid()'
        if sl in ('now()', 'now', 'current_timestamp'):
            return 'now()'
        if sl in ('true', 'false'):
            return sl
        if re.fullmatch(r"-?\d+(\.\d+)?", s):
            return s
        if s.startswith("'") and s.endswith("'"):
            return s
        if s in ('{}', '[]'):
            return "'%s'::jsonb" % s if t == 'jsonb' else "'{}'::%s" % t
        if s.startswith('[') and t.endswith('[]'):
            vals = re.findall(r"'([^']*)'|\"([^\"]*)\"|([A-Za-z0-9_-]+)", s)
            vals = [a or b or c for a, b, c in vals]
            return "ARRAY[%s]::%s" % (', '.join("'%s'" % v for v in vals), t)
        if re.fullmatch(r"[a-z0-9_.\-]+", s) and t == 'text':
            return "'%s'" % s
    # inferred fallbacks (only needed for NOT NULL optional columns).
    # Nullable columns must stay NULL — inventing now() / '' here would make
    # every row look soft-deleted, suspended, etc.
    if info.get('nullable'):
        return None
    if col == 'id' and t == 'uuid':
        return 'gen_random_uuid()'
    if t == 'timestamptz':
        return 'now()'
    if t == 'jsonb':
        return "'{}'::jsonb"
    if t == 'boolean':
        return 'false'
    if t.endswith('[]'):
        return "'{}'::%s" % t
    if t in ('numeric', 'integer'):
        return '0'
    if t == 'text':
        return "''"
    return None

def pk_for(table, cols):
    if 'id' in cols:
        return ['id']
    req = [c for c, i in cols.items() if not i['nullable'] and not i['optional']]
    for cand in ('user_id', 'store_id'):
        if cand in cols:
            return [cand]
    return req[:1] if req else []

out = io.StringIO()
w = out.write
w("""-- =====================================================================
-- nodejs_backend/db/schema.sql
-- Complete PostgreSQL schema: all %d public tables of the Supabase backend.
-- Generated from src/integrations/supabase/types.ts (authoritative column
-- list + nullability + foreign keys) merged with documented defaults from
-- complete_supabase_api_spec.md.
--
-- Plain PostgreSQL: no Supabase extensions, no RLS, no auth schema needed.
-- Run with:  psql "$DATABASE_URL" -f schema.sql
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

BEGIN;

""" % len(tables))

for t, d in tables.items():
    cols = d['cols']
    pk = pk_for(t, cols)
    w('-- ---------------------------------------------------------------------\n')
    w('-- %s (%d columns)\n' % (t, len(cols)))
    w('-- ---------------------------------------------------------------------\n')
    w('CREATE TABLE IF NOT EXISTS public.%s (\n' % t)
    defs = []
    for c, info in cols.items():
        ty = pg_type(t, c, info)
        line = '  %-34s %s' % ('"%s"' % c, ty)
        dflt = None
        if info['optional'] or c in pk:
            dflt = default_for(t, c, ty, info)
            if dflt and info['nullable'] and not (c in pk or ty == 'timestamptz' and c in ('created_at', 'updated_at')):
                # keep documented defaults for nullable columns only when the spec stated one
                if (t, c) not in spec_defaults:
                    dflt = None
        if dflt:
            line += ' DEFAULT %s' % dflt
        if not info['nullable']:
            line += ' NOT NULL'
        defs.append(line)
    if pk:
        defs.append('  CONSTRAINT %s_pkey PRIMARY KEY (%s)' % (t, ', '.join('"%s"' % c for c in pk)))
    w(',\n'.join(defs))
    w('\n);\n\n')

w('-- =====================================================================\n')
w('-- Foreign keys\n')
w('-- =====================================================================\n\n')
nfk = 0
for t, d in tables.items():
    for fk in d['fks']:
        if fk['rtable'] not in tables:
            w('-- SKIPPED (target is a view, not a table): %s -> %s\n' % (fk['name'], fk['rtable']))
            continue
        nfk += 1
        # Wrapped in a DO block so the whole file stays re-runnable: PostgreSQL
        # has no ADD CONSTRAINT IF NOT EXISTS.
        w('DO $$ BEGIN\n  ALTER TABLE public.%s ADD CONSTRAINT %s\n    FOREIGN KEY (%s) REFERENCES public.%s (%s) ON DELETE CASCADE;\nEXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;\n' % (
            t, fk['name'], ', '.join('"%s"' % c for c in fk['cols']), fk['rtable'], ', '.join('"%s"' % c for c in fk['rcols'])))
w('\n-- =====================================================================\n-- Indexes on foreign-key columns\n-- =====================================================================\n\n')
seen = set()
for t, d in tables.items():
    for fk in d['fks']:
        if fk['rtable'] not in tables:
            continue
        key = (t, tuple(fk['cols']))
        if key in seen:
            continue
        seen.add(key)
        w('CREATE INDEX IF NOT EXISTS idx_%s_%s ON public.%s (%s);\n' % (t, '_'.join(fk['cols']), t, ', '.join('"%s"' % c for c in fk['cols'])))

# Uniqueness the frontend's upserts rely on: supabase-js passes on_conflict, and
# PostgreSQL needs a matching unique index for ON CONFLICT to resolve.
UNIQUE_KEYS = [
    ('store_settings', ['store_id', 'key'], 'uq_store_settings_store_key'),
    ('onboarding_progress', ['user_id'], 'uq_onboarding_progress_user'),
    ('onboarding_answers', ['user_id', 'question_key'], 'uq_onboarding_answers_user_question'),
    ('store_custom_limits', ['store_id'], 'uq_store_custom_limits_store'),
    ('store_delivery_settings', ['store_id'], 'uq_store_delivery_settings_store'),
    ('store_theme', ['store_id'], 'uq_store_theme_store'),
    ('store_wallets', ['store_id'], 'uq_store_wallets_store'),
    ('wallets', ['user_id'], 'uq_wallets_user'),
    ('platform_stores', ['slug'], 'uq_platform_stores_slug'),
]
w("\n-- \u2500\u2500 uniqueness the frontend's upserts rely on (PostgREST on_conflict) \u2500\u2500\n")
for t, cols, name in UNIQUE_KEYS:
    if t in tables:
        w('CREATE UNIQUE INDEX IF NOT EXISTS %s ON public.%s (%s);\n' % (name, t, ', '.join('"%s"' % c for c in cols)))

w('\nCOMMIT;\n')

os.makedirs('/dev-server/nodejs_backend/db', exist_ok=True)
open('/dev-server/nodejs_backend/db/schema.sql', 'w').write(out.getvalue())
print('tables', len(tables), 'columns', sum(len(d['cols']) for d in tables.values()), 'fks', nfk)
