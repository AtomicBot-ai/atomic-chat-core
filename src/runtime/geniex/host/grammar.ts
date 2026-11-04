/**
 * A JSON schema as a llama.cpp GBNF grammar (openspec change `add-geniex-runtime`, design D6): GenieX's
 * sampler takes `grammar_string`, and its C API offers no converter, so `response_format` is turned
 * into one here — a TypeScript rendering of llama.cpp's `json_schema_to_grammar` (MIT), kept to what
 * OpenAI structured outputs use: objects with required and optional properties, arrays with bounds,
 * strings with enums, lengths and the date/time/uuid formats, numbers, integers, booleans, null,
 * `anyOf`/`oneOf`, `const`, `enum`, local `$ref`s. A schema it cannot express falls back to a looser
 * rule rather than failing the request (`unknown` → any JSON value; a `pattern` → any string).
 */

const PRIMITIVE_RULES: Record<string, string> = {
  'boolean': '("true" | "false") space',
  'decimal-part': '[0-9]{1,16}',
  'integral-part': '[0] | [1-9] [0-9]{0,15}',
  'number': '("-"? integral-part) ("." decimal-part)? ([eE] [-+]? integral-part)? space',
  'integer': '("-"? integral-part) space',
  'value': 'object | array | string | number | boolean | null',
  'object': '"{" space ( string ":" space value ("," space string ":" space value)* )? "}" space',
  'array': '"[" space ( value ("," space value)* )? "]" space',
  'uuid':
    '"\\"" [0-9a-fA-F]{8} "-" [0-9a-fA-F]{4} "-" [0-9a-fA-F]{4} "-" [0-9a-fA-F]{4} "-" [0-9a-fA-F]{12} "\\"" space',
  'char': '[^"\\\\\\x7F\\x00-\\x1F] | [\\\\] (["\\\\bfnrt] | "u" [0-9a-fA-F]{4})',
  'string': '"\\"" char* "\\"" space',
  'null': '"null" space',
}
/** Which primitive rules another one needs. */
const PRIMITIVE_DEPS: Record<string, string[]> = {
  number: ['integral-part', 'decimal-part'],
  integer: ['integral-part'],
  value: ['object', 'array', 'string', 'number', 'boolean', 'null'],
  object: ['string', 'value'],
  array: ['value'],
  string: ['char'],
}
const DATE_RULES: Record<string, string> = {
  'date': '[0-9]{4} "-" ( "0" [1-9] | "1" [0-2] ) "-" ( "0" [1-9] | [1-2] [0-9] | "3" [0-1] )',
  'time':
    '([01] [0-9] | "2" [0-3]) ":" [0-5] [0-9] ":" [0-5] [0-9] ( "." [0-9]{3} )? ( "Z" | ( "+" | "-" ) ( [01] [0-9] | "2" [0-3] ) ":" [0-5] [0-9] )',
  'date-time': 'date "T" time',
  'date-string': '"\\"" date "\\"" space',
  'time-string': '"\\"" time "\\"" space',
  'date-time-string': '"\\"" date-time "\\"" space',
}
const DATE_DEPS: Record<string, string[]> = {
  'date-time': ['date', 'time'],
  'date-string': ['date'],
  'time-string': ['time'],
  'date-time-string': ['date-time'],
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A JSON literal as a GBNF string token. */
function literal(value: unknown): string {
  const text = JSON.stringify(value)
  return `"${text.replace(/[\\"]/g, (c) => `\\${c}`).replace(/\n/g, '\\n')}"`
}

/** `{min,max}` after a rule; `*`, `+` and `?` where they say it shorter. */
function repeat(rule: string, min: number, max: number | null): string {
  if (max === null) {
    if (min === 0) return `${rule}*`
    if (min === 1) return `${rule}+`
    return `${rule}{${min},}`
  }
  if (min === max && min === 1) return rule
  if (min === 0 && max === 1) return `${rule}?`
  return `${rule}{${min},${max}}`
}

class GrammarBuilder {
  private readonly rules = new Map<string, string>([['space', '| " " | "\\n"{1,2} [ \\t]{0,20}']])
  private readonly refs: Record<string, unknown>

  constructor(private readonly root: Record<string, unknown>) {
    const defs = {
      ...(isRecord(root['definitions']) ? root['definitions'] : {}),
      ...(isRecord(root['$defs']) ? root['$defs'] : {}),
    }
    this.refs = defs
  }

  private add(name: string, rule: string): string {
    const key = name.replace(/[^a-zA-Z0-9-]+/g, '-')
    let unique = key
    let n = 0
    while (this.rules.has(unique) && this.rules.get(unique) !== rule) unique = `${key}${++n}`
    this.rules.set(unique, rule)
    return unique
  }

  private primitive(name: string): string {
    const rule = PRIMITIVE_RULES[name] ?? DATE_RULES[name]
    if (!rule) throw new Error(`no primitive ${name}`)
    if (this.rules.has(name)) return name
    // Registered before its dependencies: `value` and `object` need each other.
    this.rules.set(name, rule)
    for (const dep of PRIMITIVE_DEPS[name] ?? DATE_DEPS[name] ?? []) this.primitive(dep)
    return name
  }

  private resolve(ref: string): Record<string, unknown> {
    const match = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref)
    const target = match ? this.refs[match[1] as string] : undefined
    if (!isRecord(target)) throw new Error(`cannot resolve ${ref}`)
    return target
  }

  visit(schema: unknown, name: string): string {
    if (!isRecord(schema)) return this.primitive('value')
    const ruleName = name || 'root'
    if (typeof schema['$ref'] === 'string') return this.visit(this.resolve(schema['$ref']), ruleName)
    const types = Array.isArray(schema['type']) ? (schema['type'] as unknown[]) : schema['type']
    const alternatives = (schema['oneOf'] ?? schema['anyOf']) as unknown
    if (Array.isArray(alternatives))
      return this.add(ruleName, alternatives.map((alt, i) => this.visit(alt, `${ruleName}-${i}`)).join(' | '))
    if (Array.isArray(types))
      return this.add(
        ruleName,
        types.map((type, i) => this.visit({ ...schema, type }, `${ruleName}-${i}`)).join(' | ')
      )
    if ('const' in schema) return this.add(ruleName, `${literal(schema['const'])} space`)
    if (Array.isArray(schema['enum']))
      return this.add(ruleName, `(${(schema['enum'] as unknown[]).map(literal).join(' | ')}) space`)
    if (
      types === 'object' ||
      (types === undefined &&
        (isRecord(schema['properties']) || schema['additionalProperties'] !== undefined))
    )
      return this.object(schema, ruleName)
    if (
      types === 'array' ||
      (types === undefined && (schema['items'] !== undefined || schema['prefixItems'] !== undefined))
    )
      return this.array(schema, ruleName)
    if (types === 'string') return this.string(schema, ruleName)
    if (types === 'number' || types === 'integer' || types === 'boolean' || types === 'null')
      return this.primitive(types)
    return this.primitive('value')
  }

  private string(schema: Record<string, unknown>, name: string): string {
    const format = schema['format']
    if (format === 'date' || format === 'time' || format === 'date-time')
      return this.primitive(`${format}-string`)
    if (format === 'uuid') return this.primitive('uuid')
    const min = typeof schema['minLength'] === 'number' ? schema['minLength'] : 0
    const max = typeof schema['maxLength'] === 'number' ? schema['maxLength'] : null
    if (min === 0 && max === null) return this.primitive('string')
    this.primitive('char')
    return this.add(name, `"\\"" ${repeat('char', min, max)} "\\"" space`)
  }

  private array(schema: Record<string, unknown>, name: string): string {
    const prefix = Array.isArray(schema['prefixItems']) ? (schema['prefixItems'] as unknown[]) : null
    if (prefix) {
      const items = prefix.map((item, i) => this.visit(item, `${name}-tuple-${i}`))
      return this.add(name, `"[" space ${items.join(' "," space ')} "]" space`)
    }
    const item = this.visit(schema['items'] ?? {}, `${name}-item`)
    const min = typeof schema['minItems'] === 'number' ? schema['minItems'] : 0
    const max = typeof schema['maxItems'] === 'number' ? schema['maxItems'] : null
    const rest =
      max === null
        ? `("," space ${item})*`
        : repeat(`("," space ${item})`, Math.max(0, min - 1), Math.max(0, max - 1))
    const body = max === 0 ? '' : min === 0 ? `(${item} ${rest})?` : `${item} ${rest}`
    return this.add(name, `"[" space ${body} "]" space`.replace(/\s+/g, ' ').trim())
  }

  private object(schema: Record<string, unknown>, name: string): string {
    const properties = isRecord(schema['properties']) ? schema['properties'] : {}
    const required = new Set(Array.isArray(schema['required']) ? (schema['required'] as string[]) : [])
    const additional = schema['additionalProperties']
    const entries = Object.entries(properties)
    const kv = (key: string, valueRule: string) =>
      this.add(`${name}-${key}-kv`, `${literal(key)} space ":" space ${valueRule}`)
    const requiredRules: string[] = []
    const optionalRules: string[] = []
    for (const [key, value] of entries) {
      const rule = kv(key, this.visit(value, `${name}-${key}`))
      if (required.has(key)) requiredRules.push(rule)
      else optionalRules.push(rule)
    }
    let additionalRule: string | null = null
    if (additional === true || additional === undefined || isRecord(additional)) {
      // OpenAI structured outputs set it to false; otherwise free keys follow the typed ones.
      const value = isRecord(additional)
        ? this.visit(additional, `${name}-additional`)
        : this.primitive('value')
      this.primitive('string')
      additionalRule = this.add(`${name}-additional-kv`, `string ":" space ${value}`)
    }
    const optionals = [...optionalRules, ...(additionalRule ? [additionalRule] : [])]
    let rule = '"{" space '
    if (requiredRules.length > 0) rule += requiredRules.join(' "," space ')
    if (optionals.length > 0) {
      const tail = optionals.map((opt) =>
        additionalRule === opt ? `( "," space ${opt} )*` : `( "," space ${opt} )?`
      )
      if (requiredRules.length > 0) rule += ` ${tail.join(' ')}`
      else {
        // No required property: the first one present has no leading comma.
        const firsts = optionals.map((opt, i) => {
          const after = optionals
            .slice(i + 1)
            .map((o) => (additionalRule === o ? `( "," space ${o} )*` : `( "," space ${o} )?`))
          const self = additionalRule === opt ? `${opt} ( "," space ${opt} )*` : opt
          return `${self}${after.length > 0 ? ` ${after.join(' ')}` : ''}`
        })
        rule += `( ${firsts.join(' | ')} )?`
      }
    }
    rule += ' "}" space'
    return this.add(name, rule.replace(/\s+/g, ' ').trim())
  }

  format(): string {
    return [...this.rules.entries()].map(([name, rule]) => `${name} ::= ${rule}`).join('\n') + '\n'
  }
}

/** The GBNF for a JSON schema; `root` is the schema itself. */
export function jsonSchemaToGrammar(schema: unknown): string {
  const builder = new GrammarBuilder(isRecord(schema) ? schema : {})
  const root = builder.visit(schema, 'root')
  const text = builder.format()
  return root === 'root' ? text : `root ::= ${root}\n${text}`
}
