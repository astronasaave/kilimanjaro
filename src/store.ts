import {
  Subscriber, RawGetter, CommitOption,
  WatchHandler, WatchOption, Unsubscription,
  ActionStore,
} from './interface'
import {OptImpl, RawActions, RawGetters, RawMutations} from './opt'
import {State} from './state'
import devtoolPlugin from './devtool'
import Vue = require('vue')

interface Getters {
  [k: string]: () => any
}

interface Mutations {
  [k: string]: Array<(t?: any, o?: CommitOption) => void>
}

interface Actions {
  [k: string]: Array<(t?: any) => void | {} | Promise<void | {}>>
}

export type AnyStore = Store<{}, {}, {}, {}, {}>

const dispatchImpl = (store: AnyStore) => memoize((type: string) => (payload?: {}) => {
  let handlers = store._actions[type]
  return Promise.all(handlers.map(h => h(payload))).catch(err => {
    store._devtoolHook && store._devtoolHook.emit('vuex:error', err)
    throw err
  })
})

const commitImpl = (store: AnyStore) => memoize((type: string) => (payload?: {}, opt?: CommitOption) => {
  const mutation = {type, payload}
  let handlers = store._mutations[type]
  handlers.forEach(h => h(payload))

  if (!opt || !opt.silent) {
    store._subscribers.forEach(s => s(mutation, store.state))
  }
})

const getterImpl = (store: AnyStore) => (key: string) => store._vm[key]

export class Store<S, G, M, A, P> implements ActionStore<S, G, M, A> {

  /** @internal */ _vm: Vue
  /** @internal */ _committing = false

  /** @internal */ _getters: Getters = {}
  /** @internal */ _mutations: Mutations = {}
  /** @internal */ _actions: Actions = {}
  /** @internal */ _subscribers: Subscriber<P, S>[] = []

  /** @internal */ _devtoolHook?: {emit: Function}

  readonly dispatch: A = dispatchImpl(this) as any
  readonly commit: M = commitImpl(this) as any
  readonly getters: G = getterImpl(this) as any

  get state(): S {
    return this._vm['state']
  }

  /** @internal */ constructor(opt: OptImpl<S, G, M, A, P>) {
    let state = new State(opt._state)
    installModules(this, opt, state)
    initVM(this, state)
    opt._plugins.concat(devtoolPlugin).forEach(p => p(this))
  }

  subscribe(fn: Subscriber<P, S>): Unsubscription {
    const subs = this._subscribers
    if (subs.indexOf(fn) < 0) {
      subs.push(fn)
    }
    return () => {
      const i = subs.indexOf(fn)
      if (i > -1) {
        subs.splice(i, 1)
      }
    }
  }

  private _watcherVM = new Vue()
  watch<R>(getter: RawGetter<S, R>, cb: WatchHandler<never, R>, options: WatchOption<never, R>): Function {
    return this._watcherVM.$watch(() => getter(this.state), cb, options)
  }

  replaceState(state: S): void {
    recursiveAssign(this._vm['state'], state)
  }

}

type AnyOpt = OptImpl<{}, {}, {}, {}, {}>

function installModules(store: AnyStore, opt: AnyOpt, state: State) {
  const modules = opt._modules
  for (let key of keysOf(modules)) {
    let moduleOpt = modules[key]
    let subState = state.avtsModuleState[key] = new State(moduleOpt._state)
    installModules(store, moduleOpt, subState)
  }
  registerGetters(store, opt._getters, state)
  registerMutations(store, opt._mutations, state)
  registerActions(store, opt._actions, state)
}

function registerGetters(store: AnyStore, getters: RawGetters<{}, {}>, state: State) {
  for (let key of keysOf(getters)) {
    store._getters[key] = () => getters[key](state, store.getters)
  }
}

function registerMutations(store: AnyStore, mutations: RawMutations<{}>, state: State) {
  const _mutations = store._mutations
  for (let key of keysOf(mutations)) {
    _mutations[key] = _mutations[key] || []
    const mutation = mutations[key](state)
    _mutations[key].push(mutation)
  }
}

function registerActions(store: AnyStore, actions: RawActions<{}, {}, {}, {}>, state: State) {
  const _actions = store._actions
  for (let key of keysOf(actions)) {
    _actions[key] = _actions[key] || []
    const action = actions[key]({
      state: state,
      getters: store.getters,
      commit: store.commit,
      dispatch: store.dispatch,
    })
    _actions[key].push(action)
  }
}

function initVM(store: AnyStore, state: State) {
  // feed getters to vm as getters
  // this enable lazy-caching
  const silent = Vue.config.silent
  Vue.config.silent = false
  store._vm = new Vue({
    data: {state},
    computed: store._getters,
  })
  Vue.config.silent = silent

}

function keysOf(obj: any): string[] {
  return Object.keys(obj)
}

function recursiveAssign(o: Object, n: Object) {
  for (let key of keysOf(o)) {
    let oVal = o[key]
    let nVal = n[key]
    if (isObj(oVal) && isObj(nVal)) {
      recursiveAssign(oVal, nVal)
    } else {
      o[key] = n[key]
    }
  }
}

function isObj(o: any) {
  return o !== null && typeof o === 'object'
}

type Cacheable<R> = (this: void, k: string) => R
function memoize<R>(func: Cacheable<R>): Cacheable<R> {
  function memoized(key: string) {
    let cache: {[k: string]: R} = memoized['cache']
    if (!cache.hasOwnProperty(key)) cache[key] = func(key)
    return cache[key]
  }
  memoized['cache'] = {}
  return memoized
}
