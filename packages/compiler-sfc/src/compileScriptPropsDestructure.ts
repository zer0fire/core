import {
  Node,
  Identifier,
  BlockStatement,
  Program,
  VariableDeclaration
} from '@babel/types'
import MagicString from 'magic-string'
import { walk } from 'estree-walker'
import {
  extractIdentifiers,
  isFunctionType,
  isInDestructureAssignment,
  isReferencedIdentifier,
  isStaticProperty,
  walkFunctionParams,
  isCallOf,
  unwrapTSNode
} from '@vue/compiler-core'
import { hasOwn, genPropsAccessExp } from '@vue/shared'
import { PropsDestructureBindings } from './compileScript'

/**
 * true -> prop binding
 * false -> local binding
 */
type Scope = Record<string, boolean>

export function transformDestructuredProps(
  ast: Program,
  s: MagicString,
  offset = 0,
  knownProps: PropsDestructureBindings,
  error: (msg: string, node: Node, end?: number) => never,
  vueImportAliases: Record<string, string>
) {
  const rootScope: Scope = {}
  const scopeStack: Scope[] = [rootScope]
  let currentScope: Scope = rootScope
  const excludedIds = new WeakSet<Identifier>()
  const parentStack: Node[] = []
  const propsLocalToPublicMap: Record<string, string> = Object.create(null)

  for (const key in knownProps) {
    const { local } = knownProps[key]
    rootScope[local] = true
    propsLocalToPublicMap[local] = key
  }

  function registerLocalBinding(id: Identifier) {
    excludedIds.add(id)
    if (currentScope) {
      currentScope[id.name] = false
    } else {
      error(
        'registerBinding called without active scope, something is wrong.',
        id
      )
    }
  }

  function walkScope(node: Program | BlockStatement, isRoot = false) {
    for (const stmt of node.body) {
      if (stmt.type === 'VariableDeclaration') {
        walkVariableDeclaration(stmt, isRoot)
      } else if (
        stmt.type === 'FunctionDeclaration' ||
        stmt.type === 'ClassDeclaration'
      ) {
        if (stmt.declare || !stmt.id) continue
        registerLocalBinding(stmt.id)
      } else if (
        (stmt.type === 'ForOfStatement' || stmt.type === 'ForInStatement') &&
        stmt.left.type === 'VariableDeclaration'
      ) {
        walkVariableDeclaration(stmt.left)
      } else if (
        stmt.type === 'ExportNamedDeclaration' &&
        stmt.declaration &&
        stmt.declaration.type === 'VariableDeclaration'
      ) {
        walkVariableDeclaration(stmt.declaration, isRoot)
      } else if (
        stmt.type === 'LabeledStatement' &&
        stmt.body.type === 'VariableDeclaration'
      ) {
        walkVariableDeclaration(stmt.body, isRoot)
      }
    }
  }

  function walkVariableDeclaration(stmt: VariableDeclaration, isRoot = false) {
    if (stmt.declare) {
      return
    }
    for (const decl of stmt.declarations) {
      const isDefineProps =
        isRoot && decl.init && isCallOf(unwrapTSNode(decl.init), 'defineProps')
      for (const id of extractIdentifiers(decl.id)) {
        if (isDefineProps) {
          // for defineProps destructure, only exclude them since they
          // are already passed in as knownProps
          excludedIds.add(id)
        } else {
          registerLocalBinding(id)
        }
      }
    }
  }

  function rewriteId(
    scope: Scope,
    id: Identifier,
    parent: Node,
    parentStack: Node[]
  ): boolean {
    if (hasOwn(scope, id.name)) {
      const binding = scope[id.name]

      if (binding) {
        if (
          (parent.type === 'AssignmentExpression' && id === parent.left) ||
          parent.type === 'UpdateExpression'
        ) {
          error(`Cannot assign to destructured props as they are readonly.`, id)
        }

        if (isStaticProperty(parent) && parent.shorthand) {
          // let binding used in a property shorthand
          // skip for destructure patterns
          if (
            !(parent as any).inPattern ||
            isInDestructureAssignment(parent, parentStack)
          ) {
            // { prop } -> { prop: __props.prop }
            s.appendLeft(
              id.end! + offset,
              `: ${genPropsAccessExp(propsLocalToPublicMap[id.name])}`
            )
          }
        } else {
          // x --> __props.x
          s.overwrite(
            id.start! + offset,
            id.end! + offset,
            genPropsAccessExp(propsLocalToPublicMap[id.name])
          )
        }
      }
      return true
    }
    return false
  }

  function checkUsage(node: Node, method: string, alias = method) {
    if (isCallOf(node, alias)) {
      const arg = unwrapTSNode(node.arguments[0])
      if (arg.type === 'Identifier') {
        error(
          `"${arg.name}" is a destructured prop and should not be passed directly to ${method}(). ` +
            `Pass a getter () => ${arg.name} instead.`,
          arg
        )
      }
    }
  }

  // check root scope first
  walkScope(ast, true)
  ;(walk as any)(ast, {
    enter(node: Node, parent?: Node) {
      parent && parentStack.push(parent)

      // skip type nodes
      if (
        parent &&
        parent.type.startsWith('TS') &&
        parent.type !== 'TSAsExpression' &&
        parent.type !== 'TSNonNullExpression' &&
        parent.type !== 'TSTypeAssertion'
      ) {
        return this.skip()
      }

      checkUsage(node, 'watch', vueImportAliases.watch)
      checkUsage(node, 'toRef', vueImportAliases.toRef)

      // function scopes
      if (isFunctionType(node)) {
        scopeStack.push((currentScope = {}))
        walkFunctionParams(node, registerLocalBinding)
        if (node.body.type === 'BlockStatement') {
          walkScope(node.body)
        }
        return
      }

      // catch param
      if (node.type === 'CatchClause') {
        scopeStack.push((currentScope = {}))
        if (node.param && node.param.type === 'Identifier') {
          registerLocalBinding(node.param)
        }
        walkScope(node.body)
        return
      }

      // non-function block scopes
      if (node.type === 'BlockStatement' && !isFunctionType(parent!)) {
        scopeStack.push((currentScope = {}))
        walkScope(node)
        return
      }

      if (node.type === 'Identifier') {
        if (
          isReferencedIdentifier(node, parent!, parentStack) &&
          !excludedIds.has(node)
        ) {
          // walk up the scope chain to check if id should be appended .value
          let i = scopeStack.length
          while (i--) {
            if (rewriteId(scopeStack[i], node, parent!, parentStack)) {
              return
            }
          }
        }
      }
    },
    leave(node: Node, parent?: Node) {
      parent && parentStack.pop()
      if (
        (node.type === 'BlockStatement' && !isFunctionType(parent!)) ||
        isFunctionType(node)
      ) {
        scopeStack.pop()
        currentScope = scopeStack[scopeStack.length - 1] || null
      }
    }
  })
}
