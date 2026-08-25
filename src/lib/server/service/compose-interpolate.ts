const isNameChar = (char: string): boolean => /[\w]/u.test(char);

type Lookup = (name: string) => string | undefined;

const readBracedExpression = (text: string, start: number): number => {
  let depth = 1;
  let index = start;

  while (index < text.length && depth > 0) {
    if (text.startsWith("${", index)) {
      depth += 1;
      index += 2;
      continue;
    }

    if (text[index] === "}") {
      depth -= 1;
      index += 1;
      continue;
    }

    index += 1;
  }

  return index;
};

const resolveBraced = (expression: string, lookup: Lookup): string => {
  let nameEnd = 0;

  while (nameEnd < expression.length && isNameChar(expression[nameEnd] ?? "")) {
    nameEnd += 1;
  }

  const name = expression.slice(0, nameEnd);
  const rest = expression.slice(nameEnd);
  const value = lookup(name);

  if (rest === "") {
    return value ?? "";
  }

  const emptyIsUnset = rest.startsWith(":");
  const operator = emptyIsUnset ? rest[1] : rest[0];
  const argument = rest.slice(emptyIsUnset ? 2 : 1);
  const isSet = emptyIsUnset ? value !== undefined && value !== "" : value !== undefined;

  switch (operator) {
    case "-": {
      return isSet ? (value ?? "") : interpolateComposeVariables(argument, lookup);
    }
    case "+": {
      return isSet ? interpolateComposeVariables(argument, lookup) : "";
    }
    case "?": {
      // Best-effort: display contexts shouldn't fail on required variables.
      return value ?? "";
    }
    default: {
      return value ?? "";
    }
  }
};

/**
 * Resolves docker-compose style `${VAR}` interpolation against the provided
 * variables. Supports `$VAR`, `${VAR}`, `${VAR:-default}`, `${VAR-default}`,
 * `${VAR:?err}`, `${VAR?err}`, `${VAR:+alt}`, `${VAR+alt}`, nested defaults,
 * and the `$$` escape. Unset variables resolve to an empty string.
 */
export function interpolateComposeVariables(text: string, lookup: Lookup): string {
  let result = "";
  let index = 0;

  while (index < text.length) {
    const char = text[index];

    if (char !== "$") {
      result += char;
      index += 1;
      continue;
    }

    if (text[index + 1] === "$") {
      result += "$";
      index += 2;
      continue;
    }

    if (text[index + 1] === "{") {
      const end = readBracedExpression(text, index + 2);
      const expression = text.slice(index + 2, end - 1);
      result += resolveBraced(expression, lookup);
      index = end;
      continue;
    }

    let nameEnd = index + 1;

    while (nameEnd < text.length && isNameChar(text[nameEnd] ?? "")) {
      nameEnd += 1;
    }

    if (nameEnd === index + 1) {
      result += "$";
      index += 1;
      continue;
    }

    result += lookup(text.slice(index + 1, nameEnd)) ?? "";
    index = nameEnd;
  }

  return result;
}
