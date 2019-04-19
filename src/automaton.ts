import {Term, TermSet, Precedence, Rule} from "./grammar"

export class Pos {
  constructor(readonly rule: Rule,
              readonly pos: number,
              readonly ahead: Term,
              readonly prec: ReadonlyArray<Precedence>) {}

  get next() {
    return this.pos < this.rule.parts.length ? this.rule.parts[this.pos] : null
  }

  advance() {
    return new Pos(this.rule, this.pos + 1, this.ahead, this.rule.precedence[this.pos + 1] || none)
  }

  cmp(pos: Pos) {
    return this.cmpSimple(pos) || this.ahead.cmp(pos.ahead) || cmpSet(this.prec, pos.prec, (a, b) => a.cmp(b))
  }

  cmpSimple(pos: Pos) {
    return this.rule.cmp(pos.rule) || this.pos - pos.pos
  }

  toString() {
    let parts = this.rule.parts.map(t => t.name)
    parts.splice(this.pos, 0, "·")
    return `${this.rule.name} -> ${parts.join(" ")}`
  }

  termsAhead(first: {[name: string]: Term[]}): Term[] {
    let found: Term[] = []
    for (let pos = this.pos + 1; pos < this.rule.parts.length; pos++) {
      let next = this.rule.parts[pos], cont = false
      for (let term of next.terminal ? [next] : first[next.name]) {
        if (term == null) cont = true
        else if (!found.includes(term)) found.push(term)
      }
      if (!cont) return found
    }
    if (!found.includes(this.ahead)) found.push(this.ahead)
    return found
  }
}

function advance(set: Pos[], expr: Term): Pos[] {
  let result = []
  for (let pos of set) if (pos.next == expr) result.push(pos.advance())
  return result
}

function advanceWithPrec(set: Pos[], expr: Term): {set: Pos[], prec: ReadonlyArray<Precedence>} {
  let result = [], prec = none as Precedence[]
  for (let pos of set) if (pos.next == expr) {
    for (let p of pos.prec) {
      if (prec == none) prec = []
      if (!prec.some(x => x.eq(p))) prec.push(p)
    }
    result.push(pos.advance())
  }
  return {set: result, prec}
}

function cmpSet<T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>, cmp: (a: T, b: T) => number) {
  if (a.length != b.length) return a.length - b.length
  for (let i = 0; i < a.length; i++) {
    let diff = cmp(a[i], b[i])
    if (diff) return diff
  }
  return 0
}

export class Shift {
  constructor(readonly term: Term, readonly target: State) {}

  eq(other: Shift | Reduce): boolean { return other instanceof Shift && other.target == this.target }

  toString() { return "s" + this.target.id }

  map(mapping: number[], states: State[]) { return new Shift(this.term, states[mapping[this.target.id]]) }
}

export class Reduce {
  constructor(readonly term: Term, readonly rule: Rule) {}

  eq(other: Shift | Reduce): boolean { return other instanceof Reduce && other.rule == this.rule }

  toString() { return `${this.rule.name.name}(${this.rule.parts.length})` }

  map() { return this }
}

const ACCEPTING = 1 /*FIXME unused*/, AMBIGUOUS = 2 // FIXME maybe store per terminal

export class State {
  terminals: (Shift | Reduce)[] = []
  terminalPrec: ReadonlyArray<Precedence>[] = []
  goto: Shift[] = []
  recover: Shift[] = []

  constructor(readonly id: number, readonly set: ReadonlyArray<Pos>, public flags = 0) {}

  get ambiguous() { return (this.flags & AMBIGUOUS) > 0 }
  get accepting() { return (this.flags & ACCEPTING) > 0 }

  toString() {
    let actions = this.terminals.map(t => t.term + "=" + t).join(",") +
      (this.goto.length ? " | " + this.goto.map(g => g.term + "=" + g).join(",") : "")
    return this.id + ": " + this.set.filter(p => p.pos > 0).join() + (actions.length ? "\n  " + actions : "")
  }

  addAction(value: Shift | Reduce, prec: ReadonlyArray<Precedence>, pos?: Pos): boolean {
    check: for (let i = 0; i < this.terminals.length; i++) {
      let action = this.terminals[i]
      if (action.term == value.term) {
        if (action.eq(value)) return true
        if (!prec.some(p => p.value == Precedence.REPEAT))
          this.flags |= AMBIGUOUS
        let prev = this.terminalPrec[i]
        for (let p of prec) if (p.isAmbig) {
          if (prev.some(x => x.isAmbig && x.group == p.group)) continue check
        }
        let main = prec.find(x => !x.isAmbig), prevMain = prev.find(x => !x.isAmbig)
        let diff = (main ? main.value : 0) - (prevMain ? prevMain.value : 0)
        if (diff == 0 && main && main.associativity)
          diff = main.associativity == "left" ? 1 : -1
        if (diff > 0) { // Drop the existing action
          this.terminals.splice(i, 1)
          this.terminalPrec.splice(i, 1)
          i--
          continue check
        } else if (diff < 0) { // Drop this one
          return true
        } else { // Not resolved
          if (!pos) return false
          if (action instanceof Shift)
            throw new Error(`shift/reduce conflict at ${pos} for ${action.term}`)
          else
            throw new Error(`reduce/reduce conflict between ${pos.rule} and ${action.rule} for ${action.term}`)
        }
      }
    }
    this.terminals.push(value)
    this.terminalPrec.push(prec)
    return true
  }

  getGoto(term: Term) {
    return this.goto.find(a => a.term == term)
  }
}

function closure(set: ReadonlyArray<Pos>, rules: ReadonlyArray<Rule>, first: {[name: string]: Term[]}) {
  let result = set.slice(), added: {[key: string]: boolean} = Object.create(null)
  for (let x of result) if (x.pos == 0) added[x.rule.id + "." + x.ahead.id] = true
  for (let pos of result) {
    let next = pos.next
    if (!next || next.terminal) continue
    let ahead = pos.termsAhead(first)
    for (let rule of rules) if (rule.name == next) {
      for (let a of ahead) {
        let key = rule.id + "." + a.id
        if (!added[key]) {
          result.push(new Pos(rule, 0, a, Precedence.join(pos.prec, rule.precAt(0))))
          added[key] = true
        }
      }
    }
  }
  return result.sort((a, b) => a.cmp(b))
}

function add<T>(value: T, array: T[]) {
  if (!array.includes(value)) array.push(value)
}

function computeFirst(rules: ReadonlyArray<Rule>, nonTerminals: Term[]) {
  let table: {[term: string]: Term[]} = {}
  for (let t of nonTerminals) table[t.name] = []
  for (;;) {
    let change = false
    for (let rule of rules) {
      let set = table[rule.name.name]
      let found = false, startLen = set.length
      for (let part of rule.parts) {
        found = true
        if (part.terminal) {
          add(part, set)
        } else {
          for (let t of table[part.name]) {
            if (t == null) found = false
            else add(t, set)
          }
        }
        if (found) break
      }
      if (!found) add(null, set)
      if (set.length > startLen) change = true
    }
    if (!change) return table
  }
}

// Builds a full LR(1) automaton
export function buildFullAutomaton(rules: ReadonlyArray<Rule>, terms: TermSet, first: {[name: string]: Term[]}) {
  let states: State[] = []
  function explore(set: Pos[]) {
    if (set.length == 0) return null
    set = closure(set, rules, first)
    let state = states.find(s => cmpSet(s.set, set, (a, b) => a.cmp(b)) == 0)
    if (!state) {
      states.push(state = new State(states.length, set))
      for (let term of terms.terminals) if (!term.eof && !term.error) {
        let {set: newSet, prec} = advanceWithPrec(set, term)
        let next = explore(newSet)
        if (next) state.addAction(new Shift(term, next), prec)
      }
      for (let nt of terms.nonTerminals) {
        let goto = explore(advance(set, nt))
        if (goto) state.goto.push(new Shift(nt, goto))
      }
      let program = state.set.findIndex(pos => pos.pos == 0 && pos.rule.name.program)
      if (program > -1) {
        let accepting = new State(states.length, none, ACCEPTING)
        states.push(accepting)
        state.goto.push(new Shift(state.set[program].rule.name, accepting))
      }
      for (let pos of set) if (pos.next == null)
        state.addAction(new Reduce(pos.ahead, pos.rule), pos.rule.rulePrec(), pos)
    }
    return state
  }

  explore(rules.filter(rule => rule.name.name == "program").map(rule => new Pos(rule, 0, terms.eof, rule.precAt(0))))
  return states
}

function mergeState(mapping: number[], newStates: State[], state: State, target: State): boolean {
  for (let j = 0; j < state.terminals.length; j++)
    if (!target.addAction(state.terminals[j].map(mapping, newStates), state.terminalPrec[j]))
      return false
  for (let goto of state.goto) {
    if (!target.goto.find(a => a.term == goto.term))
      target.goto.push(goto.map(mapping, newStates))
  }
  return true
}

function markConflicts(mapping: number[], newID: number, oldStates: State[], newStates: State[], conflicts: number[]) {
  // For all combinations of merged states
  for (let i = 0; i < mapping.length; i++) if (mapping[i] == newID) {
    for (let j = 0; j < mapping.length; j++) if (j != i && mapping[j] == newID) {
      // Create a dummy state to determine whether there's a conflict
      let state = new State(0, none)
      mergeState(mapping, newStates, oldStates[i], state)
      if (!mergeState(mapping, newStates, oldStates[j], state)) conflicts.push(i, j)
    }
  }
}

function hasConflict(id: number, newID: number, mapping: number[], conflicts: number[]) {
  for (let i = 0; i < conflicts.length; i++) if (conflicts[i] == id) {
    let other = conflicts[i + (i % 2 ? -1 : 1)] // Pick other side of the pair
    if (mapping[other] == newID) return true
  }
  return false
}

// Collapse an LR(1) automaton to an LALR-like automaton
function collapseAutomaton(states: State[]): State[] {
  let conflicts: number[] = []
  for (;;) {
    let newStates: State[] = [], mapping: number[] = []
    for (let i = 0; i < states.length; i++) {
      let state = states[i], set: Pos[] = []
      for (let pos of state.set) if (!set.some(p => p.cmpSimple(pos) == 0)) set.push(pos)
      let newID = newStates.findIndex((s, index) => {
        return cmpSet(s.set, set, (a, b) => a.cmpSimple(b)) == 0 &&
          !hasConflict(i, index, mapping, conflicts)
      })
      if (newID < 0) {
        newID = newStates.length
        newStates.push(new State(newID, set, state.flags))
      } else {
        newStates[newID].flags |= state.flags
      }
      mapping.push(newID)
    }
    let conflicting: number[] = []
    for (let i = 0; i < states.length; i++) {
      let newID = mapping[i]
      if (conflicting.includes(newID)) continue // Don't do work for states that are known to conflict
      if (!mergeState(mapping, newStates, states[i], newStates[mapping[i]])) {
        conflicting.push(newID)
        markConflicts(mapping, newID, states, newStates, conflicts)
      }
    }
    if (!conflicting.length) return newStates
  }
}

const none: ReadonlyArray<any> = []

function addRecoveryRules(table: State[], rules: ReadonlyArray<Rule>, first: {[name: string]: Term[]}) {
  for (let state of table) {
    for (let pos of state.set) if (pos.pos > 0) {
      for (let i = pos.pos + 1; i < pos.rule.parts.length; i++) {
        let part = pos.rule.parts[i]
        terms: for (let term of (part.terminal ? [part] : first[part.name])) if (term && !state.recover.some(a => a.term == term)) {
          let next = pos.rule.parts[pos.pos]
          let action = next.terminal ? state.terminals.find(t => t.term == next) : state.getGoto(next)
          if (!action || !(action instanceof Shift)) continue
          state.recover.push(new Shift(term, action.target))
        }
      }
    }
  }
}

export function buildAutomaton(rules: ReadonlyArray<Rule>, terms: TermSet) {
  let first = computeFirst(rules, terms.nonTerminals)
  let table = collapseAutomaton(buildFullAutomaton(rules, terms, first))
  addRecoveryRules(table, rules, first)
  return table
}