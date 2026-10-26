export type GameFormulaContext = {
  variable: (scope: 'scene' | 'campaign', id: string) => number;
  item: (id: string) => number;
  health: (id: string) => number;
  time: number;
  frame: number;
};
export type GameFormula = (context: GameFormulaContext) => number;

const functions: Record<string, [number, number, (...values: number[]) => number]> = {
  min: [2, 8, Math.min],
  max: [2, 8, Math.max],
  abs: [1, 1, Math.abs],
  floor: [1, 1, Math.floor],
  ceil: [1, 1, Math.ceil],
  round: [1, 1, Math.round],
  sqrt: [1, 1, Math.sqrt],
  pow: [2, 2, Math.pow],
  clamp: [3, 3, (value, low, high) => Math.max(low, Math.min(high, value))],
};

/** Parse arithmetic and explicit game-state reads. No JS, property access, loops or external calls. */
export function compileGameFormula(source: string): GameFormula {
  if (!source.trim() || source.length > 256) throw new Error('Use a formula of 1–256 characters.');
  const tokens =
    source.match(
      /(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|[a-zA-Z_][a-zA-Z0-9_]*|"[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}"|[()+\-*/%,]|\S/gi,
    ) ?? [];
  if (tokens.length > 128) throw new Error('A formula may contain at most 128 tokens.');
  let offset = 0;
  const error = () => new Error(`Invalid formula near token ${offset + 1}: ${tokens[offset] ?? 'end'}.`);
  const expect = (token: string) => {
    if (tokens[offset++] !== token) throw error();
  };
  const finite = (value: number) => {
    if (!Number.isFinite(value))
      throw new Error('Formula result must be finite; check division and numeric ranges.');
    return value;
  };
  function primary(depth: number): GameFormula {
    if (depth > 16) throw new Error('Formula nesting may not exceed 16 levels.');
    const token = tokens[offset++];
    if (token === '-' || token === '+') {
      const child = primary(depth + 1);
      return (context) => (token === '-' ? -child(context) : child(context));
    }
    if (token === '(') {
      const result = expression(0, depth + 1);
      expect(')');
      return result;
    }
    if (token && /^(?:\d|\.)/.test(token)) {
      const value = finite(Number(token));
      return () => value;
    }
    if (token === 'time' || token === 'frame') return (context) => context[token];
    if (token === 'pi') return () => Math.PI;
    if (token === 'scene' || token === 'campaign' || token === 'item' || token === 'health') {
      expect('(');
      const argument = tokens[offset++];
      if (!argument || !/^"[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}"$/.test(argument)) throw error();
      const id = argument.slice(1, -1);
      expect(')');
      return (context) =>
        token === 'scene' || token === 'campaign' ? context.variable(token, id) : context[token](id);
    }
    const fn = token && Object.hasOwn(functions, token) ? functions[token] : undefined;
    if (!fn) throw error();
    expect('(');
    const args: GameFormula[] = [];
    if (tokens[offset] !== ')') {
      do {
        if (args.length === fn[1]) throw new Error(`Too many arguments to ${token}.`);
        args.push(expression(0, depth + 1));
      } while (tokens[offset] === ',' && ++offset);
    }
    expect(')');
    if (args.length < fn[0]) throw new Error(`Too few arguments to ${token}.`);
    return (context) => finite(fn[2](...args.map((arg) => arg(context))));
  }
  function expression(minimum: number, depth: number): GameFormula {
    let left = primary(depth);
    while (offset < tokens.length) {
      const operator = tokens[offset];
      const precedence =
        operator === '+' || operator === '-'
          ? 1
          : operator === '*' || operator === '/' || operator === '%'
            ? 2
            : -1;
      if (precedence < minimum) break;
      offset++;
      const previous = left,
        right = expression(precedence + 1, depth + 1);
      left = (context) => {
        const a = previous(context),
          b = right(context);
        return finite(
          operator === '+'
            ? a + b
            : operator === '-'
              ? a - b
              : operator === '*'
                ? a * b
                : operator === '/'
                  ? a / b
                  : a % b,
        );
      };
    }
    return left;
  }
  const result = expression(0, 0);
  if (offset !== tokens.length) throw error();
  return (context) => finite(result(context));
}
