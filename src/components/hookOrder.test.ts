import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * React 的 Hook 必须每次渲染调用同样多次。
 *
 * 组件里写了 `if (!xxx) return null` 之后又调 useState / useEffect / useMemo 之类，
 * 关闭时少调一个、打开时多调一个，React 会抛
 * "Rendered more hooks than during the previous render" 并卸载整棵树，
 * 用户看到的就是「点开详情页立刻白屏」。
 *
 * 这类问题 tsc 查不出来（类型完全合法），普通单测也照不到（测试不会先空再满渲染两次），
 * 所以这里用语法树静态扫描：找函数体顶层「提前 return」之后出现的 Hook 调用。
 */

const sources = import.meta.glob('./*.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

interface Violation {
  file: string
  line: number
  hook: string
}

function isHookCall(node: ts.Node): string {
  if (!ts.isCallExpression(node)) return ''
  const callee = node.expression
  if (ts.isIdentifier(callee) && /^use[A-Z]/.test(callee.text)) return callee.text
  return ''
}

/** 收集一段代码里出现的所有 Hook 名称（含嵌套，因为整条语句都会被执行） */
function hooksIn(node: ts.Node): string[] {
  const found: string[] = []
  const visit = (n: ts.Node) => {
    const hook = isHookCall(n)
    if (hook) found.push(hook)
    ts.forEachChild(n, visit)
  }
  visit(node)
  return found
}

/** 顶层 if 里直接 return（含 `if (a) return` 与 `if (a) { return ... }`） */
function isEarlyReturn(stmt: ts.Statement): boolean {
  if (!ts.isIfStatement(stmt)) return false
  const then = stmt.thenStatement
  if (ts.isReturnStatement(then)) return true
  if (ts.isBlock(then)) return then.statements.some((item) => ts.isReturnStatement(item))
  return false
}

/**
 * 带函数体的声明：函数声明、函数表达式、箭头函数、方法。
 * `ts.isFunctionLike` 还会匹配只有签名的重载 / 调用签名，那些没有 body，得先滤掉。
 */
type WithBody = ts.FunctionDeclaration | ts.FunctionExpression | ts.MethodDeclaration

function hasFunctionBody(node: ts.Node): node is WithBody {
  return ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isMethodDeclaration(node)
}

function analyze(file: string): Violation[] {
  const source = sources[file]
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const violations: Violation[] = []

  const checkBody = (body: ts.Block) => {
    let earlyReturnSeen = false
    for (const stmt of body.statements) {
      if (earlyReturnSeen) {
        for (const hook of hooksIn(stmt)) {
          const { line } = sf.getLineAndCharacterOfPosition(stmt.getStart(sf))
          violations.push({ file, line: line + 1, hook })
        }
      }
      if (isEarlyReturn(stmt)) earlyReturnSeen = true
    }
  }

  const visit = (node: ts.Node) => {
    // const Foo = () => { ... } 这类箭头函数组件：只处理带块体（{ }）的，表达式体不可能提前 return
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isArrowFunction(node.initializer)) {
      const body = node.initializer.body
      if (/^[A-Z]/.test(node.name.getText(sf)) && ts.isBlock(body)) checkBody(body)
    }
    if (hasFunctionBody(node)) {
      const name = node.name?.getText(sf) ?? ''
      // 只看组件（大写开头）或无名的默认导出函数
      const isComponent = !name || /^[A-Z]/.test(name)
      const body = node.body as ts.Node | undefined
      if (isComponent && body && ts.isBlock(body)) checkBody(body)
    }
    ts.forEachChild(node, visit)
  }

  visit(sf)
  return violations
}

describe('组件不得在提前 return 之后调用 Hook', () => {
  const files = Object.keys(sources).filter((file) => !file.endsWith('.test.tsx'))

  it('扫描到组件文件', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  it('没有组件把 Hook 写在提前 return 之后', () => {
    const violations = files.flatMap(analyze)
    const message = violations
      .map((item) => `${item.file}:${item.line}  ${item.hook}`)
      .join('\n')
    expect(message).toBe('')
  })
})
