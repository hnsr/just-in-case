export const VARIABLE_NAME = /^[A-Za-z_][A-Za-z_0-9]*$/

export function evaluateFormula(input, variable) {
  if (typeof input === 'number' && Number.isFinite(input)) return input
  if (typeof input !== 'string' || input.length > 160) throw new Error('Enter a number or a formula of up to 160 characters.')
  const source = input.trim().replace(/^=\s*/, '')
  const tokens = source.match(/(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z_0-9]*|[^\s]/g) ?? []
  let index = 0

  function primary() {
    const token = tokens[index++]
    if (token === '(') {
      const value = sum()
      if (tokens[index++] !== ')') throw new Error('Missing closing parenthesis.')
      return value
    }
    if (/^(?:\d|\.\d)/.test(token ?? '')) return Number(token)
    if (token && VARIABLE_NAME.test(token)) return variable(token)
    throw new Error(token ? 'Unexpected token “' + token + '”.' : 'Enter a number or a formula.')
  }

  function unary() {
    if (tokens[index] === '+' || tokens[index] === '-') {
      const sign = tokens[index++] === '+' ? 1 : -1
      return sign * unary()
    }
    const value = primary()
    if (tokens[index] !== '^') return value
    index++
    return value ** unary()
  }

  function product() {
    let value = unary()
    while (['*', '/', '%'].includes(tokens[index])) {
      const operator = tokens[index++]
      const right = unary()
      if ((operator === '/' || operator === '%') && right === 0) throw new Error('Division by zero.')
      if (operator === '*') value *= right
      else if (operator === '/') value /= right
      else value %= right
    }
    return value
  }

  function sum() {
    let value = product()
    while (tokens[index] === '+' || tokens[index] === '-') {
      const operator = tokens[index++]
      const right = product()
      value += operator === '+' ? right : -right
    }
    return value
  }

  const result = sum()
  if (index !== tokens.length) throw new Error('Unexpected token “' + tokens[index] + '”.')
  if (!Number.isFinite(result)) throw new Error('The result must be a finite number.')
  return result
}
