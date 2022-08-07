const defaultDbName = 'lazy-idb-keyval'

export function openStore(name: string): OpenStore {
  const storeName = name + '-store'
  const request = indexedDB.open(name)
  request.addEventListener(
    'upgradeneeded',
    () => {
      request.result.createObjectStore(storeName)
    },
    { once: true }
  )

  const promise = wrap(request)

  return mode =>
    promise.then(db => db.transaction(storeName, mode).objectStore(storeName))
}

type OpenStore = (mode: IDBTransactionMode) => Promise<IDBObjectStore>

let defaultOpenStore: OpenStore
function getDefaultStore() {
  if (!defaultOpenStore) {
    defaultOpenStore = openStore(defaultDbName)
  }
  return defaultOpenStore
}

function wrap<T = undefined>(
  input: IDBTransaction | IDBRequest<T>
): Promise<T> {
  const controller = new AbortController()
  const options = { once: true, signal: controller.signal }

  return new Promise<T>((resolve, reject) => {
    function error() {
      reject(input.error)
      controller.abort()
    }
    if (input instanceof IDBRequest) {
      input.addEventListener(
        'success',
        () => {
          resolve(input.result)
          controller.abort()
        },
        options
      )
      input.addEventListener('error', error, options)
    } else if (input instanceof IDBTransaction) {
      input.addEventListener(
        'complete',
        () => {
          resolve(undefined as any)
          controller.abort()
        },
        options
      )
      input.addEventListener('error', error, options)
      input.addEventListener('abort', error, options)
    } else {
      resolve(input)
    }
  })
}

type GetAction = {
  type: 'get'
  key: IDBValidKey
  resolve: (value: any) => void
  reject: (error: any) => void
}

type ListAction = {
  type: 'keys' | 'values' | 'entries'
  resolve: (value: any) => void
  reject: (error: any) => void
}

type SetAction = {
  type: 'set'
  key: IDBValidKey
  value: any
}

type UpdateAction = {
  type: 'update'
  key: IDBValidKey
  updater: (currentValue: any) => any
}

type DelAction = {
  type: 'del'
  key: IDBValidKey
}

type ClearAction = {
  type: 'clear'
}

type ReadAction = GetAction | ListAction
type PartialReadAction =
  | Omit<GetAction, 'resolve' | 'reject'>
  | Omit<ListAction, 'resolve' | 'reject'>
type WriteAction = SetAction | UpdateAction | DelAction | ClearAction
type Action = ReadAction | WriteAction

const actionsQueueMap = new WeakMap<OpenStore, Action[]>()
const transactionPromiseMap = new WeakMap<OpenStore, Promise<undefined>>()

function enqueueAction(openStore: OpenStore, action: Action) {
  const actions = actionsQueueMap.get(openStore) || []
  actions.push(action)
  actionsQueueMap.set(openStore, actions)
}

function enqueueWriteAction(
  openStore: OpenStore,
  action: WriteAction
): Promise<undefined> {
  enqueueAction(openStore, action)
  return transactionPromise(openStore)
}

function enqueueReadAction<T>(openStore: OpenStore, action: PartialReadAction) {
  const resultPromise = new Promise<T>((resolve, reject) => {
    enqueueAction(openStore, Object.assign(action, { resolve, reject }))
  })
  return Promise.race([resultPromise, transactionPromise(openStore)])
}

function transactionPromise(openStore: OpenStore): Promise<undefined> {
  if (!transactionPromiseMap.has(openStore)) {
    transactionPromiseMap.set(openStore, commit(openStore))
  }
  return transactionPromiseMap.get(openStore) as Promise<undefined>
}

async function commit(openStore: OpenStore): Promise<undefined> {
  const store = await openStore('readwrite')

  const actions = actionsQueueMap.get(openStore) || []
  for (const action of actions) {
    switch (action.type) {
      case 'get':
      case 'keys':
      case 'values': {
        const request =
          action.type === 'get'
            ? store.get(action.key)
            : action.type === 'keys'
            ? store.getAllKeys()
            : store.getAll()

        wrap(request).then(action.resolve, action.reject)
        break
      }
      case 'entries': {
        try {
          const [keys, values] = await Promise.all([
            wrap(store.getAllKeys()),
            wrap(store.getAll()),
          ])
          action.resolve(keys.map((key, i) => [key, values[i]]))
        } catch (e) {
          action.reject(e)
        }
        break
      }
      case 'update': {
        const request = store.get(action.key)
        request.addEventListener(
          'success',
          () => {
            store.put(action.updater(request.result), action.key)
          },
          { once: true }
        )
        break
      }
      case 'set': {
        store.put(action.value, action.key)
        break
      }
      case 'del': {
        store.delete(action.key)
        break
      }
      case 'clear': {
        store.clear()
        break
      }
    }
  }

  actionsQueueMap.set(openStore, [])
  transactionPromiseMap.delete(openStore)

  return wrap(store.transaction)
}

export async function get<T = any>(
  key: IDBValidKey,
  openStore = getDefaultStore()
): Promise<T | undefined> {
  return enqueueReadAction<T>(openStore, {
    type: 'get',
    key,
  })
}

export function set(
  key: IDBValidKey,
  value: any,
  openStore = getDefaultStore()
): Promise<undefined> {
  return enqueueWriteAction(openStore, {
    type: 'set',
    key,
    value,
  })
}

export function update<T = any>(
  key: IDBValidKey,
  updater: (oldValue: T | undefined) => T,
  openStore = getDefaultStore()
): Promise<undefined> {
  return enqueueWriteAction(openStore, {
    type: 'update',
    key,
    updater,
  })
}

export function del(
  key: IDBValidKey,
  openStore = getDefaultStore()
): Promise<undefined> {
  return enqueueWriteAction(openStore, {
    type: 'del',
    key,
  })
}

export function clear(openStore = getDefaultStore()): Promise<undefined> {
  return enqueueWriteAction(openStore, {
    type: 'clear',
  })
}

export function keys<T extends IDBValidKey>(
  openStore = getDefaultStore()
): Promise<T[] | undefined> {
  return enqueueReadAction<T[]>(openStore, {
    type: 'keys',
  })
}

export function values<T = any>(
  openStore = getDefaultStore()
): Promise<T[] | undefined> {
  return enqueueReadAction<T[]>(openStore, {
    type: 'values',
  })
}

export function entries<T extends IDBValidKey, U = any>(
  openStore = getDefaultStore()
): Promise<[T, U][] | undefined> {
  return enqueueReadAction<[T, U][]>(openStore, {
    type: 'entries',
  })
}
