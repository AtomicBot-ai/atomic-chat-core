import { describe, expect, it } from 'vitest'
import { jsonSchemaToGrammar } from './grammar.js'

const rule = (grammar: string, name: string): string | undefined =>
  grammar
    .split('\n')
    .find((line) => line.startsWith(`${name} ::= `))
    ?.slice(name.length + 5)

describe('jsonSchemaToGrammar (task 5.4, design D6)', () => {
  it('renders an object with required and optional properties, additionalProperties off', () => {
    const grammar = jsonSchemaToGrammar({
      type: 'object',
      properties: { city: { type: 'string' }, days: { type: 'integer' }, unit: { enum: ['c', 'f'] } },
      required: ['city'],
      additionalProperties: false,
    })
    expect(rule(grammar, 'root')).toBe(
      '"{" space root-city-kv ( "," space root-days-kv )? ( "," space root-unit-kv )? "}" space'
    )
    expect(rule(grammar, 'root-city-kv')).toBe('"\\"city\\"" space ":" space string')
    expect(rule(grammar, 'root-days-kv')).toBe('"\\"days\\"" space ":" space integer')
    expect(rule(grammar, 'root-unit')).toBe('("\\"c\\"" | "\\"f\\"") space')
    expect(rule(grammar, 'string')).toBe('"\\"" char* "\\"" space')
    expect(rule(grammar, 'integer')).toBe('("-"? integral-part) space')
    expect(rule(grammar, 'space')).toBe('| " " | "\\n"{1,2} [ \\t]{0,20}')
    expect(grammar).not.toContain('additional')
  })

  it('lets free keys follow the typed ones unless additionalProperties is false, and handles no required at all', () => {
    const open = jsonSchemaToGrammar({ type: 'object', properties: { a: { type: 'boolean' } } })
    expect(rule(open, 'root')).toBe(
      '"{" space ( root-a-kv ( "," space root-additional-kv )* | root-additional-kv ( "," space root-additional-kv )* )? "}" space'
    )
    expect(rule(open, 'root-additional-kv')).toBe('string ":" space value')
    const anyObject = jsonSchemaToGrammar({ type: 'object' })
    expect(rule(anyObject, 'root')).toContain('root-additional-kv')
  })

  it('renders arrays with bounds, tuples, strings with lengths and formats, unions, consts and refs', () => {
    const grammar = jsonSchemaToGrammar({
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 },
        pair: { type: 'array', prefixItems: [{ type: 'number' }, { type: 'null' }] },
        code: { type: 'string', minLength: 2, maxLength: 4 },
        when: { type: 'string', format: 'date-time' },
        id: { type: 'string', format: 'uuid' },
        kind: { const: 'weather' },
        either: { anyOf: [{ type: 'integer' }, { type: 'string' }] },
        both: { type: ['boolean', 'null'] },
        nested: { $ref: '#/$defs/point' },
      },
      required: ['tags', 'pair', 'code', 'when', 'id', 'kind', 'either', 'both', 'nested'],
      additionalProperties: false,
      $defs: {
        point: {
          type: 'object',
          properties: { x: { type: 'number' } },
          required: ['x'],
          additionalProperties: false,
        },
      },
    })
    expect(rule(grammar, 'root-tags')).toBe('"[" space string ("," space string){0,2} "]" space')
    expect(rule(grammar, 'root-pair')).toBe('"[" space number "," space null "]" space')
    expect(rule(grammar, 'root-code')).toBe('"\\"" char{2,4} "\\"" space')
    expect(rule(grammar, 'root-when-kv')).toBe('"\\"when\\"" space ":" space date-time-string')
    expect(rule(grammar, 'date-time')).toBe('date "T" time')
    expect(rule(grammar, 'root-id-kv')).toBe('"\\"id\\"" space ":" space uuid')
    expect(rule(grammar, 'root-kind')).toBe('"\\"weather\\"" space')
    expect(rule(grammar, 'root-either')).toBe('integer | string')
    expect(rule(grammar, 'root-both')).toBe('boolean | null')
    expect(rule(grammar, 'root-nested')).toBe('"{" space root-nested-x-kv "}" space')
  })

  it('falls back to any JSON value for a schema it cannot read, and to any string for a pattern', () => {
    const any = jsonSchemaToGrammar({})
    expect(rule(any, 'root')).toBe('value')
    expect(rule(any, 'value')).toBe('object | array | string | number | boolean | null')
    expect(jsonSchemaToGrammar('nope').startsWith('root ::= value\n')).toBe(true)
    const pattern = jsonSchemaToGrammar({ type: 'string', pattern: '^[a-z]+$' })
    expect(rule(pattern, 'root')).toBe('string')
    expect(rule(pattern, 'string')).toBe('"\\"" char* "\\"" space')
    const unbounded = jsonSchemaToGrammar({ type: 'array', items: { type: 'integer' } })
    expect(rule(unbounded, 'root')).toBe('"[" space (integer ("," space integer)*)? "]" space')
  })
})
