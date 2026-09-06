import { z, type ZodTypeAny } from 'zod';

/**
 * Zod → JSON Schema (Draft 2020-12, OpenAPI-3.1-kompatibel).
 *
 * Architekturentscheid: eine eigene, knappe Umsetzung statt einer weiteren
 * Abhängigkeit. Sie deckt genau die Konstrukte ab, die in diesem Projekt
 * tatsächlich vorkommen, und ist damit vollständig — nicht allgemein.
 * Trifft sie auf etwas Unbekanntes, wirft sie: eine stillschweigend
 * unvollständige Spezifikation wäre schlimmer als ein Fehlschlag beim
 * Erzeugen.
 *
 * Der Nutzen dieses Wegs: die Spezifikation stammt aus denselben Schemas, die
 * zur Laufzeit validieren. Eine Doku, die von der Validierung abweichen
 * *kann*, weicht früher oder später ab.
 */

export interface JsonSchema {
  [key: string]: unknown;
}

/**
 * Zods interne Definition ist nicht öffentlich typisiert und je Typ anders
 * geformt. Ein gemeinsamer, offener Zugriffstyp ist hier ehrlicher als ein
 * Dutzend punktueller Zusicherungen.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ZodDef = { typeName: string; description?: string } & Record<string, any>;

const Kind = z.ZodFirstPartyTypeKind;

export function zodToJsonSchema(input: ZodTypeAny): JsonSchema {
  const def = input._def as ZodDef;
  const described = (schema: JsonSchema): JsonSchema =>
    def.description ? { ...schema, description: def.description } : schema;

  switch (def.typeName) {
    case Kind.ZodString: {
      const schema: JsonSchema = { type: 'string' };
      for (const check of (def.checks ?? []) as ZodDef[]) {
        if (check.kind === 'min') schema.minLength = check.value;
        if (check.kind === 'max') schema.maxLength = check.value;
        if (check.kind === 'email') schema.format = 'email';
        if (check.kind === 'url') schema.format = 'uri';
        if (check.kind === 'uuid') schema.format = 'uuid';
        if (check.kind === 'datetime') schema.format = 'date-time';
        if (check.kind === 'regex') schema.pattern = String(check.regex?.source ?? '');
      }
      return described(schema);
    }

    case Kind.ZodNumber: {
      const schema: JsonSchema = { type: 'number' };
      for (const check of (def.checks ?? []) as ZodDef[]) {
        if (check.kind === 'min') schema.minimum = check.value;
        if (check.kind === 'max') schema.maximum = check.value;
        if (check.kind === 'int') schema.type = 'integer';
      }
      return described(schema);
    }

    case Kind.ZodBoolean:
      return described({ type: 'boolean' });

    case Kind.ZodDate:
      // Über die Leitung reist ein Datum immer als ISO-8601-Zeichenkette.
      return described({ type: 'string', format: 'date-time' });

    case Kind.ZodLiteral:
      return described({ const: def.value });

    case Kind.ZodEnum:
      return described({ type: 'string', enum: def.values });

    case Kind.ZodNativeEnum:
      return described({ type: 'string', enum: Object.values(def.values as object) });

    case Kind.ZodArray: {
      const schema: JsonSchema = { type: 'array', items: zodToJsonSchema(def.type) };
      if (def.minLength) schema.minItems = def.minLength.value;
      if (def.maxLength) schema.maxItems = def.maxLength.value;
      return described(schema);
    }

    case Kind.ZodObject: {
      const shape = (input as z.ZodObject<z.ZodRawShape>).shape;
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];

      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value as ZodTypeAny);
        if (!isOptional(value as ZodTypeAny)) required.push(key);
      }

      const schema: JsonSchema = { type: 'object', properties };
      if (required.length) schema.required = required;
      return described(schema);
    }

    case Kind.ZodOptional:
    case Kind.ZodNullable:
      return zodToJsonSchema(def.innerType);

    case Kind.ZodDefault:
      return { ...zodToJsonSchema(def.innerType), default: def.defaultValue() };

    case Kind.ZodEffects:
      // `.refine()` / `.superRefine()` / `.transform()` — die Form bestimmt
      // das innere Schema; die Regel selbst steht in der Beschreibung.
      return described(zodToJsonSchema(def.schema));

    case Kind.ZodUnion:
      return described({ anyOf: (def.options as ZodTypeAny[]).map(zodToJsonSchema) });

    case Kind.ZodDiscriminatedUnion:
      return described({
        oneOf: Array.from(def.options as Iterable<ZodTypeAny>).map(zodToJsonSchema),
        discriminator: { propertyName: def.discriminator },
      });

    case Kind.ZodRecord:
      return described({
        type: 'object',
        additionalProperties: zodToJsonSchema(def.valueType),
      });

    case Kind.ZodAny:
    case Kind.ZodUnknown:
      return {};

    default:
      throw new Error(
        `zodToJsonSchema: nicht unterstützter Typ „${def.typeName}". ` +
          'Bitte im Konverter ergänzen, statt das Feld stillschweigend auszulassen.',
      );
  }
}

/** Ein Feld ist optional, wenn es Optional, Nullable oder Default trägt. */
function isOptional(schema: ZodTypeAny): boolean {
  const def = schema._def as ZodDef;
  return (
    def.typeName === Kind.ZodOptional ||
    def.typeName === Kind.ZodDefault ||
    def.typeName === Kind.ZodNullable ||
    (def.typeName === Kind.ZodEffects && isOptional(def.schema))
  );
}

/**
 * Zerlegt ein Objektschema in einzelne OpenAPI-Parameter.
 * Wird für Query-Strings und Pfadsegmente gebraucht, die OpenAPI nicht als
 * Objekt kennt.
 */
export function zodToParameters(
  schema: ZodTypeAny,
  location: 'query' | 'path',
): Record<string, unknown>[] {
  const json = zodToJsonSchema(schema);
  const properties = (json.properties ?? {}) as Record<string, JsonSchema>;
  const required = (json.required ?? []) as string[];

  return Object.entries(properties).map(([name, propertySchema]) => ({
    name,
    in: location,
    required: location === 'path' ? true : required.includes(name),
    schema: propertySchema,
    ...(propertySchema.description ? { description: propertySchema.description } : {}),
  }));
}
