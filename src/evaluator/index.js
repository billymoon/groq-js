const {StaticValue, StreamValue, NULL_VALUE, TRUE_VALUE, FALSE_VALUE} = require('./value')
const functions = require('./functions')
const operators = require('./operators')

class Scope {
  constructor(params, source, value, parent) {
    this.params = params
    this.source = source
    this.value = value
    this.parent = parent
  }

  createNested(value) {
    return new Scope(this.params, this.source, value, this)
  }
}

function execute(node, scope) {
  const func = EXECUTORS[node.type]
  if (!func) throw new Error('No executor for node.type=' + node.type)
  return func(node, scope)
}

const EXECUTORS = {
  This(_, scope) {
    return scope.value
  },

  Star(_, scope) {
    return scope.source.createSink()
  },

  Parent(_, scope) {
    return scope.parent ? scope.parent.value : NULL_VALUE
  },

  OpCall({op, left, right}, scope) {
    let func = operators[op]
    if (!func) throw new Error('Unknown operator: ' + op)
    return func(left, right, scope, execute)
  },

  FuncCall({name, args}, scope) {
    let func = functions[name]
    if (!func) throw new Error('Unknown function: ' + name)
    return func(args, scope, execute)
  },

  async Filter({base, query}, scope) {
    let baseValue = await execute(base, scope)
    if (baseValue.getType() != 'array') return NULL_VALUE

    return new StreamValue(async function*() {
      for await (let value of baseValue) {
        let newScope = scope.createNested(value)
        let condValue = await execute(query, newScope)
        if (condValue.getBoolean()) yield value
      }
    })
  },

  async Element({base, index}, scope) {
    let arrayValue = await execute(base, scope)
    if (arrayValue.getType() != 'array') return NULL_VALUE

    let idxValue = await execute(index, scope)
    if (idxValue.getType() != 'number') return NULL_VALUE

    // OPT: Here we can optimize when idx >= 0
    let array = await arrayValue.get()
    let idx = await idxValue.get()

    if (idx < 0) {
      idx = array.length + idx
    }

    if (idx >= 0 && idx < array.length) {
      return new StaticValue(array[idx])
    } else {
      // Make sure we return `null` for out-of-bounds access
      return NULL_VALUE
    }
  },

  async Slice({base, left, right, isExclusive}, scope) {
    let arrayValue = await execute(base, scope)
    if (arrayValue.getType() != 'array') return NULL_VALUE

    let leftIdxValue = await execute(left, scope)
    let rightIdxValue = await execute(right, scope)

    if (leftIdxValue.getType() != 'number' || rightIdxValue.getType() != 'number') {
      return null
    }

    // OPT: Here we can optimize when either indices are >= 0
    let array = await arrayValue.get()
    let leftIdx = await leftIdxValue.get()
    let rightIdx = await rightIdxValue.get()

    // Handle negative index
    if (leftIdx < 0) leftIdx = array.length + leftIdx
    if (rightIdx < 0) rightIdx = array.length + rightIdx

    // Convert from inclusive to exclusive index
    if (!isExclusive) rightIdx++

    if (leftIdx < 0) leftIdx = 0
    if (rightIdx < 0) rightIdx = 0

    // Note: At this point the indices might point out-of-bound, but
    // .slice handles this correctly.

    return new StaticValue(array.slice(leftIdx, rightIdx))
  },

  async Attribute({base, name}, scope) {
    let baseValue = await execute(base, scope)

    if (baseValue.getType() == 'object') {
      let baseData = await baseValue.get()
      if (baseData.hasOwnProperty(name)) {
        return new StaticValue(baseData[name])
      }
    }

    return NULL_VALUE
  },

  async Identifier({name}, scope) {
    if (scope.value.getType() == 'object') {
      let data = await scope.value.get()
      if (data.hasOwnProperty(name)) {
        return new StaticValue(data[name])
      }
    }

    return NULL_VALUE
  },

  Value({value}) {
    return new StaticValue(value)
  },

  async Projection({base, query}, scope) {
    let baseValue = await execute(base, scope)

    if (baseValue.getType() == 'array') {
      return new StreamValue(async function*() {
        for await (let value of baseValue) {
          let newScope = scope.createNested(value)
          let newValue = await execute(query, newScope)
          yield newValue
        }
      })
    } else {
      let newScope = scope.createNested(baseValue)
      return await execute(query, newScope)
    }
  },

  async Flatten({base}, scope) {
    let baseValue = await execute(base, scope)
    if (baseValue.getType() != 'array') return NULL_VALUE

    return new StreamValue(async function*() {
      for await (let value of baseValue) {
        if (value.getType() == 'array') {
          for await (let element of value) {
            yield element
          }
        } else {
          yield NULL_VALUE
        }
      }
    })
  },

  async Deref({base}, scope) {
    let baseValue = await execute(base, scope)
    if (baseValue.getType() != 'object') return NULL_VALUE

    let id = (await baseValue.get())._ref
    if (typeof id != 'string') return NULL_VALUE

    for await (let doc of scope.source.createSink()) {
      if (id === doc.data._id) {
        return doc
      }
    }

    return NULL_VALUE
  },

  async Object({attributes}, scope) {
    let result = {}
    for (let attr of attributes) {
      switch (attr.type) {
        case 'ObjectSplat':
          Object.assign(result, scope.value)
          break

        case 'ObjectAttribute':
          let key = await execute(attr.key, scope)
          if (key.getType() != 'string') continue

          let value = await execute(attr.value, scope)
          if (value.getType() == 'null') continue

          result[key.data] = await value.get()
          break

        default:
          throw new Error('Unknown node type: ' + attr.type)
      }
    }
    return new StaticValue(result)
  },

  Array({elements}, scope) {
    return new StreamValue(async function*() {
      for (let element of elements) {
        yield await execute(element, scope)
      }
    })
  },

  async And({left, right}, scope) {
    let leftValue = await execute(left, scope)
    if (!leftValue.getBoolean()) return FALSE_VALUE

    let rightValue = await execute(right, scope)
    if (!rightValue.getBoolean()) return FALSE_VALUE

    return TRUE_VALUE
  },

  async Not({base}, scope) {
    let value = await execute(base, scope)
    return value.getBoolean() ? FALSE_VALUE : TRUE_VALUE
  }
}

class StaticSource {
  constructor(documents) {
    this.documents = documents
  }

  createSink() {
    return new StaticValue(this.documents)
  }
}

async function evaluate(tree, options = {}) {
  let source
  let params = {identity: 'groot'}

  if (options.documents != null) {
    if (!Array.isArray(options.documents)) {
      throw new Error('documents must be an array')
    }

    source = new StaticSource(options.documents)
  } else {
    source = new StaticSource([])
  }

  if (options.params) {
    Object.assign(params, options.params)
  }

  let scope = new Scope(params, source, NULL_VALUE, null)
  return await execute(tree, scope)
}

exports.evaluate = evaluate
