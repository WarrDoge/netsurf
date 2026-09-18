/* Polyfiller for Duktape for NetSurf
 *
 * This JavaScript will be loaded into heaps before the generics
 *
 * We only care for the side-effects of this, be careful.
 */

// Production steps of ECMA-262, Edition 6, 22.1.2.1
if (!Array.from) {
  Array.from = (function () {
    var toStr = Object.prototype.toString;
    var isCallable = function (fn) {
      return typeof fn === 'function' || toStr.call(fn) === '[object Function]';
    };
    var toInteger = function (value) {
      var number = Number(value);
      if (isNaN(number)) { return 0; }
      if (number === 0 || !isFinite(number)) { return number; }
      return (number > 0 ? 1 : -1) * Math.floor(Math.abs(number));
    };
    var maxSafeInteger = Math.pow(2, 53) - 1;
    var toLength = function (value) {
      var len = toInteger(value);
      return Math.min(Math.max(len, 0), maxSafeInteger);
    };

    // The length property of the from method is 1.
    return function from(arrayLike/*, mapFn, thisArg */) {
      // 1. Let C be the this value.
      var C = this;

      // 2. Let items be ToObject(arrayLike).
      var items = Object(arrayLike);

      // 3. ReturnIfAbrupt(items).
      if (arrayLike == null) {
        throw new TypeError('Array.from requires an array-like object - not null or undefined');
      }

      // 4. If mapfn is undefined, then let mapping be false.
      var mapFn = arguments.length > 1 ? arguments[1] : void undefined;
      var T;
      if (typeof mapFn !== 'undefined') {
        // 5. else
        // 5. a If IsCallable(mapfn) is false, throw a TypeError exception.
        if (!isCallable(mapFn)) {
          throw new TypeError('Array.from: when provided, the second argument must be a function');
        }

        // 5. b. If thisArg was supplied, let T be thisArg; else let T be undefined.
        if (arguments.length > 2) {
          T = arguments[2];
        }
      }

      // 10. Let lenValue be Get(items, "length").
      // 11. Let len be ToLength(lenValue).
      var len = toLength(items.length);

      // 13. If IsConstructor(C) is true, then
      // 13. a. Let A be the result of calling the [[Construct]] internal method 
      // of C with an argument list containing the single item len.
      // 14. a. Else, Let A be ArrayCreate(len).
      var A = isCallable(C) ? Object(new C(len)) : new Array(len);

      // 16. Let k be 0.
      var k = 0;
      // 17. Repeat, while k < len… (also steps a - h)
      var kValue;
      while (k < len) {
        kValue = items[k];
        if (mapFn) {
          A[k] = typeof T === 'undefined' ? mapFn(kValue, k) : mapFn.call(T, kValue, k);
        } else {
          A[k] = kValue;
        }
        k += 1;
      }
      // 18. Let putStatus be Put(A, "length", len, true).
      A.length = len;
      // 20. Return A.
      return A;
    };
  }());
}

// DOMTokenList formatter, in theory we can remove this if we do the stringifier IDL support

DOMTokenList.prototype.toString = function () {
  if (this.length == 0) {
    return "";
  }

  var ret = this.item(0);
  for (var index = 1; index < this.length; index++) {
    ret = ret + " " + this.item(index);
  }

  return ret;
}

// Inherit the same toString for settable lists
DOMSettableTokenList.prototype.toString = DOMTokenList.prototype.toString;

/* Promise, and the microtask queue it runs on.
 *
 * Duktape 2.7 is ES5.1 with pieces of ES2015 and has no Promise. Nothing
 * needs promises to be fast, but a great deal of modern code needs them to
 * exist, so a polyfill is the right trade here.
 *
 * Reactions are queued rather than run inline, as the specification
 * requires. The host drains the queue after each script and each event
 * through NetSurfDrainMicrotasks, which dukky moves off the global object
 * once this file has run.
 */
var NetSurfPromiseSupport = (function () {
  var queue = [];
  var draining = false;

  function enqueue(job) {
    queue.push(job);
  }

  function drain() {
    if (draining) {
      return;
    }
    draining = true;
    try {
      /* a job may queue further jobs, which must run in the same drain */
      while (queue.length > 0) {
        var job = queue.shift();
        job();
      }
    } finally {
      draining = false;
    }
  }

  var PENDING = 0, FULFILLED = 1, REJECTED = 2;

  function isThenable(x) {
    return x !== null &&
        (typeof x === 'object' || typeof x === 'function') &&
        typeof x.then === 'function';
  }

  function settle(promise, state, value) {
    if (promise._state !== PENDING) {
      return;
    }

    promise._state = state;
    promise._value = value;

    var reactions = promise._reactions;
    promise._reactions = [];

    for (var i = 0; i < reactions.length; i++) {
      enqueue(reactions[i]);
    }
  }

  function resolve(promise, value) {
    if (promise._state !== PENDING) {
      return;
    }

    if (value === promise) {
      settle(promise, REJECTED,
             new TypeError('Chaining cycle detected for promise'));
      return;
    }

    if (isThenable(value)) {
      var called = false;
      try {
        value.then(function (v) {
          if (!called) { called = true; resolve(promise, v); }
        }, function (e) {
          if (!called) { called = true; settle(promise, REJECTED, e); }
        });
      } catch (e) {
        if (!called) { called = true; settle(promise, REJECTED, e); }
      }
      return;
    }

    settle(promise, FULFILLED, value);
  }

  function react(promise, onFulfilled, onRejected, next) {
    return function () {
      var handler = promise._state === FULFILLED ? onFulfilled : onRejected;

      if (typeof handler !== 'function') {
        /* pass the settled value straight through the chain */
        if (promise._state === FULFILLED) {
          resolve(next, promise._value);
        } else {
          settle(next, REJECTED, promise._value);
        }
        return;
      }

      try {
        resolve(next, handler(promise._value));
      } catch (e) {
        settle(next, REJECTED, e);
      }
    };
  }

  function Promise(executor) {
    if (!(this instanceof Promise)) {
      throw new TypeError("Constructor Promise requires 'new'");
    }
    if (typeof executor !== 'function') {
      throw new TypeError('Promise resolver is not a function');
    }

    this._state = PENDING;
    this._value = undefined;
    this._reactions = [];

    var self = this;
    try {
      executor(function (v) { resolve(self, v); },
               function (e) { settle(self, REJECTED, e); });
    } catch (e) {
      settle(self, REJECTED, e);
    }
  }

  Promise.prototype.then = function (onFulfilled, onRejected) {
    var next = new Promise(function () {});
    var job = react(this, onFulfilled, onRejected, next);

    if (this._state === PENDING) {
      this._reactions.push(job);
    } else {
      enqueue(job);
    }

    return next;
  };

  Promise.prototype['catch'] = function (onRejected) {
    return this.then(undefined, onRejected);
  };

  Promise.prototype['finally'] = function (onFinally) {
    return this.then(function (v) {
      if (typeof onFinally === 'function') { onFinally(); }
      return v;
    }, function (e) {
      if (typeof onFinally === 'function') { onFinally(); }
      throw e;
    });
  };

  Promise.resolve = function (value) {
    if (value instanceof Promise) {
      return value;
    }
    return new Promise(function (res) { res(value); });
  };

  Promise.reject = function (reason) {
    return new Promise(function (res, rej) { rej(reason); });
  };

  Promise.all = function (items) {
    return new Promise(function (res, rej) {
      var values = [];
      var remaining = 0;
      var done = false;

      function one(index, item) {
        remaining++;
        Promise.resolve(item).then(function (v) {
          values[index] = v;
          if (--remaining === 0 && done) { res(values); }
        }, rej);
      }

      for (var i = 0; i < items.length; i++) {
        one(i, items[i]);
      }

      done = true;
      if (remaining === 0) { res(values); }
    });
  };

  Promise.race = function (items) {
    return new Promise(function (res, rej) {
      for (var i = 0; i < items.length; i++) {
        Promise.resolve(items[i]).then(res, rej);
      }
    });
  };

  Promise.allSettled = function (items) {
    return Promise.all(Array.prototype.map.call(items, function (item) {
      return Promise.resolve(item).then(function (value) {
        return { status: 'fulfilled', value: value };
      }, function (reason) {
        return { status: 'rejected', reason: reason };
      });
    }));
  };

  return { promise: Promise, drain: drain };
})();



/* querySelector, querySelectorAll, matches and closest.
 *
 * libdom has no selector engine and does not link libcss, so this is a
 * separate implementation of the selector subset that scripts actually use:
 * type, universal, id, class, attribute, the four combinators, selector
 * lists, and the structural and state pseudo classes below. It is not the
 * engine that styles the page, so a selector it does not understand throws
 * rather than silently matching nothing.
 *
 * The upgrade path, if the two ever disagree in a way that matters, is to
 * expose libcss's own parser and matcher and drive them through the
 * css_select_handler vtable NetSurf already implements over libdom nodes.
 */
(function () {
  var ELEMENT_NODE = 1;

  function isSpace(ch) {
    return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
  }

  function Reader(text) {
    this.text = text;
    this.pos = 0;
  }

  Reader.prototype.peek = function () {
    return this.pos < this.text.length ? this.text.charAt(this.pos) : '';
  };

  Reader.prototype.next = function () {
    return this.text.charAt(this.pos++);
  };

  Reader.prototype.skipSpace = function () {
    var skipped = false;
    while (this.pos < this.text.length && isSpace(this.peek())) {
      this.pos++;
      skipped = true;
    }
    return skipped;
  };

  Reader.prototype.fail = function (why) {
    throw new Error("'" + this.text + "' is not a valid selector: " + why);
  };

  /* an identifier, with backslash escapes honoured */
  Reader.prototype.ident = function () {
    var out = '';
    while (this.pos < this.text.length) {
      var ch = this.peek();
      if (ch === '\\') {
        this.pos++;
        out += this.next();
        continue;
      }
      if (/[-_a-zA-Z0-9 -￿]/.test(ch)) {
        out += ch;
        this.pos++;
        continue;
      }
      break;
    }
    if (out === '') {
      this.fail('expected an identifier');
    }
    return out;
  };

  Reader.prototype.string = function () {
    var quote = this.next();
    var out = '';
    while (this.pos < this.text.length) {
      var ch = this.next();
      if (ch === '\\') {
        out += this.next();
      } else if (ch === quote) {
        return out;
      } else {
        out += ch;
      }
    }
    this.fail('unterminated string');
  };

  /* a value in an attribute selector, quoted or bare */
  Reader.prototype.value = function () {
    var ch = this.peek();
    if (ch === '"' || ch === "'") {
      return this.string();
    }
    return this.ident();
  };

  function parseCompound(r) {
    var compound = { tag: null, id: null, classes: [], attrs: [], pseudos: [] };
    var seen = false;

    while (r.pos < r.text.length) {
      var ch = r.peek();

      if (ch === '*') {
        r.pos++;
        seen = true;
      } else if (ch === '#') {
        r.pos++;
        compound.id = r.ident();
        seen = true;
      } else if (ch === '.') {
        r.pos++;
        compound.classes.push(r.ident());
        seen = true;
      } else if (ch === '[') {
        r.pos++;
        r.skipSpace();
        var attr = { name: r.ident(), op: null, value: null };
        r.skipSpace();
        if (r.peek() !== ']') {
          var op = r.next();
          if (op !== '=') {
            if (r.peek() !== '=') {
              r.fail('unknown attribute operator');
            }
            r.pos++;
            op = op + '=';
          }
          attr.op = op;
          r.skipSpace();
          attr.value = r.value();
          r.skipSpace();
        }
        if (r.next() !== ']') {
          r.fail('expected ]');
        }
        compound.attrs.push(attr);
        seen = true;
      } else if (ch === ':') {
        r.pos++;
        if (r.peek() === ':') {
          r.fail('pseudo elements cannot be selected');
        }
        var pseudo = { name: r.ident().toLowerCase(), arg: null, sub: null };
        if (r.peek() === '(') {
          r.pos++;
          if (pseudo.name === 'not') {
            r.skipSpace();
            pseudo.sub = parseCompound(r);
            r.skipSpace();
          } else {
            var depth = 1;
            var arg = '';
            while (r.pos < r.text.length) {
              var c = r.next();
              if (c === '(') { depth++; }
              if (c === ')') { depth--; if (depth === 0) { break; } }
              arg += c;
            }
            if (depth !== 0) {
              r.fail('expected )');
            }
            pseudo.arg = arg;
            compound.pseudos.push(pseudo);
            seen = true;
            continue;
          }
          if (r.next() !== ')') {
            r.fail('expected )');
          }
        }
        compound.pseudos.push(pseudo);
        seen = true;
      } else if (/[-_a-zA-Z -￿\\]/.test(ch)) {
        if (compound.tag !== null) {
          break;
        }
        compound.tag = r.ident().toUpperCase();
        seen = true;
      } else {
        break;
      }
    }

    if (!seen) {
      r.fail('expected a simple selector');
    }

    return compound;
  }

  /* One group is a list of {combinator, compound} read left to right. The
   * first entry's combinator is null.
   */
  function parseGroup(r) {
    var parts = [{ combinator: null, compound: parseCompound(r) }];

    while (r.pos < r.text.length) {
      var space = r.skipSpace();
      var ch = r.peek();

      if (ch === '' || ch === ',') {
        break;
      }

      var combinator = ' ';
      if (ch === '>' || ch === '+' || ch === '~') {
        combinator = ch;
        r.pos++;
        r.skipSpace();
      } else if (!space) {
        r.fail('expected a combinator');
      }

      parts.push({ combinator: combinator, compound: parseCompound(r) });
    }

    return parts;
  }

  var cache = {};

  function parseSelector(text) {
    if (Object.prototype.hasOwnProperty.call(cache, text)) {
      return cache[text];
    }

    var r = new Reader(String(text));
    var groups = [];

    r.skipSpace();
    groups.push(parseGroup(r));

    while (r.peek() === ',') {
      r.pos++;
      r.skipSpace();
      groups.push(parseGroup(r));
    }

    r.skipSpace();
    if (r.pos !== r.text.length) {
      r.fail('trailing junk');
    }

    cache[text] = groups;
    return groups;
  }

  function classesOf(el) {
    var name = el.className;
    if (typeof name !== 'string') {
      name = el.getAttribute('class') || '';
    }
    return name.split(/\s+/);
  }

  function attrMatches(el, attr) {
    var have = el.getAttribute(attr.name);
    if (have === null || have === undefined) {
      return false;
    }
    if (attr.op === null) {
      return true;
    }
    switch (attr.op) {
    case '=':  return have === attr.value;
    case '~=': return attr.value !== '' &&
                      have.split(/\s+/).indexOf(attr.value) !== -1;
    case '|=': return have === attr.value ||
                      have.indexOf(attr.value + '-') === 0;
    case '^=': return attr.value !== '' && have.indexOf(attr.value) === 0;
    case '$=': return attr.value !== '' &&
                      have.lastIndexOf(attr.value) ===
                              have.length - attr.value.length;
    case '*=': return attr.value !== '' && have.indexOf(attr.value) !== -1;
    }
    return false;
  }

  /* an+b, plus the odd and even keywords */
  function parseNth(arg) {
    var text = String(arg).replace(/\s+/g, '').toLowerCase();

    if (text === 'odd') { return { a: 2, b: 1 }; }
    if (text === 'even') { return { a: 2, b: 0 }; }

    var m = /^([-+]?\d*)n([-+]\d+)?$/.exec(text);
    if (m) {
      var a = m[1];
      if (a === '' || a === '+') { a = 1; } else if (a === '-') { a = -1; }
      return { a: parseInt(a, 10), b: m[2] ? parseInt(m[2], 10) : 0 };
    }

    if (/^[-+]?\d+$/.test(text)) {
      return { a: 0, b: parseInt(text, 10) };
    }

    throw new Error("'" + arg + "' is not a valid nth expression");
  }

  function nthMatches(nth, index) {
    if (nth.a === 0) {
      return index === nth.b;
    }
    var n = (index - nth.b) / nth.a;
    return n >= 0 && n === Math.floor(n);
  }

  function siblings(el, sameType) {
    var out = [];
    var parent = el.parentNode;

    if (parent === null || parent === undefined) {
      return [el];
    }

    var child = parent.firstChild;
    while (child !== null && child !== undefined) {
      if (child.nodeType === ELEMENT_NODE &&
          (!sameType || child.nodeName === el.nodeName)) {
        out.push(child);
      }
      child = child.nextSibling;
    }

    return out;
  }

  function pseudoMatches(el, pseudo) {
    var list;

    switch (pseudo.name) {
    case 'root':
      return el.parentNode !== null && el.parentNode !== undefined &&
             el.parentNode.nodeType !== ELEMENT_NODE;

    case 'empty':
      var child = el.firstChild;
      while (child !== null && child !== undefined) {
        if (child.nodeType === ELEMENT_NODE) { return false; }
        if (child.nodeType === 3 && child.nodeValue !== '') { return false; }
        child = child.nextSibling;
      }
      return true;

    case 'first-child':
      return siblings(el, false)[0] === el;

    case 'last-child':
      list = siblings(el, false);
      return list[list.length - 1] === el;

    case 'only-child':
      return siblings(el, false).length === 1;

    case 'first-of-type':
      return siblings(el, true)[0] === el;

    case 'last-of-type':
      list = siblings(el, true);
      return list[list.length - 1] === el;

    case 'only-of-type':
      return siblings(el, true).length === 1;

    case 'nth-child':
      return nthMatches(parseNth(pseudo.arg),
                        siblings(el, false).indexOf(el) + 1);

    case 'nth-last-child':
      list = siblings(el, false);
      return nthMatches(parseNth(pseudo.arg), list.length - list.indexOf(el));

    case 'nth-of-type':
      return nthMatches(parseNth(pseudo.arg),
                        siblings(el, true).indexOf(el) + 1);

    case 'nth-last-of-type':
      list = siblings(el, true);
      return nthMatches(parseNth(pseudo.arg), list.length - list.indexOf(el));

    case 'not':
      return !compoundMatches(el, pseudo.sub);

    case 'checked':
      return el.checked === true;

    case 'disabled':
      return el.disabled === true;

    case 'enabled':
      return el.disabled === false;

    case 'link':
      return (el.nodeName === 'A' || el.nodeName === 'AREA') &&
             el.hasAttribute('href');
    }

    throw new Error("':" + pseudo.name + "' is not a supported pseudo class");
  }

  function compoundMatches(el, compound) {
    var i;

    if (compound.tag !== null && el.nodeName !== compound.tag) {
      return false;
    }

    if (compound.id !== null && el.id !== compound.id) {
      return false;
    }

    if (compound.classes.length > 0) {
      var have = classesOf(el);
      for (i = 0; i < compound.classes.length; i++) {
        if (have.indexOf(compound.classes[i]) === -1) {
          return false;
        }
      }
    }

    for (i = 0; i < compound.attrs.length; i++) {
      if (!attrMatches(el, compound.attrs[i])) {
        return false;
      }
    }

    for (i = 0; i < compound.pseudos.length; i++) {
      if (!pseudoMatches(el, compound.pseudos[i])) {
        return false;
      }
    }

    return true;
  }

  function previousElement(el) {
    var sib = el.previousSibling;
    while (sib !== null && sib !== undefined && sib.nodeType !== ELEMENT_NODE) {
      sib = sib.previousSibling;
    }
    return sib;
  }

  /* Walk the group right to left, which lets each step fail fast. */
  function groupMatches(el, parts, index) {
    if (!compoundMatches(el, parts[index].compound)) {
      return false;
    }

    if (index === 0) {
      return true;
    }

    var combinator = parts[index].combinator;
    var node;

    if (combinator === '>') {
      node = el.parentNode;
      return node !== null && node !== undefined &&
             node.nodeType === ELEMENT_NODE &&
             groupMatches(node, parts, index - 1);
    }

    if (combinator === '+') {
      node = previousElement(el);
      return node !== null && node !== undefined &&
             groupMatches(node, parts, index - 1);
    }

    if (combinator === '~') {
      node = previousElement(el);
      while (node !== null && node !== undefined) {
        if (groupMatches(node, parts, index - 1)) { return true; }
        node = previousElement(node);
      }
      return false;
    }

    node = el.parentNode;
    while (node !== null && node !== undefined &&
           node.nodeType === ELEMENT_NODE) {
      if (groupMatches(node, parts, index - 1)) { return true; }
      node = node.parentNode;
    }
    return false;
  }

  function matchesSelector(el, text) {
    var groups = parseSelector(text);
    for (var i = 0; i < groups.length; i++) {
      if (groupMatches(el, groups[i], groups[i].length - 1)) {
        return true;
      }
    }
    return false;
  }

  /* getElementsByTagName("*") is in document order, which is the order
   * querySelectorAll has to return.
   */
  function descendants(root) {
    if (typeof root.getElementsByTagName === 'function') {
      return root.getElementsByTagName('*');
    }

    var out = [];
    (function walk(node) {
      var child = node.firstChild;
      while (child !== null && child !== undefined) {
        if (child.nodeType === ELEMENT_NODE) {
          out.push(child);
          walk(child);
        }
        child = child.nextSibling;
      }
    }(root));
    return out;
  }

  function queryAll(root, text) {
    var groups = parseSelector(text);
    var candidates = descendants(root);
    var count = candidates.length;
    var out = [];

    for (var i = 0; i < count; i++) {
      var el = candidates.item ? candidates.item(i) : candidates[i];
      for (var g = 0; g < groups.length; g++) {
        if (groupMatches(el, groups[g], groups[g].length - 1)) {
          out.push(el);
          break;
        }
      }
    }

    return out;
  }

  function queryFirst(root, text) {
    var found = queryAll(root, text);
    return found.length > 0 ? found[0] : null;
  }

  /* The generated bindings already define querySelector and
   * querySelectorAll from the WebIDL, as unimplemented methods that return
   * undefined, and they are not writable, so a plain assignment would fail
   * silently and leave the stub in place.
   */
  function define(proto, name, fn) {
    try {
      Object.defineProperty(proto, name, {
        value: fn,
        writable: true,
        enumerable: false,
        configurable: true
      });
    } catch (e) {
      /* an older build may still carry the generated stub */
      proto[name] = fn;
    }
  }

  function install(proto) {
    if (typeof proto === 'undefined' || proto === null) {
      return;
    }
    define(proto, 'querySelector', function (text) {
      return queryFirst(this, text);
    });
    define(proto, 'querySelectorAll', function (text) {
      return queryAll(this, text);
    });
  }

  install(typeof Document !== 'undefined' ? Document.prototype : null);
  install(typeof Element !== 'undefined' ? Element.prototype : null);
  install(typeof DocumentFragment !== 'undefined' ?
          DocumentFragment.prototype : null);

  if (typeof Element !== 'undefined') {
    define(Element.prototype, 'matches', function (text) {
      return matchesSelector(this, text);
    });

    define(Element.prototype, 'closest', function (text) {
      var node = this;
      while (node !== null && node !== undefined &&
             node.nodeType === ELEMENT_NODE) {
        if (matchesSelector(node, text)) { return node; }
        node = node.parentNode;
      }
      return null;
    });
  }
}());

/* Storage, and requestAnimationFrame over the timer.
 *
 * Neither is persistent and neither is a real animation clock. What they
 * give is the shape scripts feature detect for, so a page that stores a
 * preference or schedules a frame runs instead of dying on a ReferenceError.
 * Storage is per page load: a reload starts empty, which for the cache-like
 * use most pages put it to means a miss rather than a wrong answer.
 *
 * Making localStorage outlive the page needs a file under the per-user
 * configuration directory, and that needs a binding rather than a polyfill.
 */
var NetSurfHostSupport = (function () {
  function makeStorage() {
    var data = {};
    var storage = {};

    function keys() {
      var out = [];
      for (var k in data) {
        if (Object.prototype.hasOwnProperty.call(data, k)) {
          out.push(k);
        }
      }
      return out;
    }

    function resize() {
      storage.length = keys().length;
    }

    storage.length = 0;

    storage.getItem = function (key) {
      key = String(key);
      return Object.prototype.hasOwnProperty.call(data, key) ?
              data[key] : null;
    };

    storage.setItem = function (key, value) {
      data[String(key)] = String(value);
      resize();
    };

    storage.removeItem = function (key) {
      delete data[String(key)];
      resize();
    };

    storage.clear = function () {
      data = {};
      resize();
    };

    storage.key = function (index) {
      var all = keys();
      index = Number(index);
      return (index >= 0 && index < all.length) ? all[index] : null;
    };

    return storage;
  }

  /* The frame callback is given a page relative time, as the timestamp is
   * specified to be, not a wall clock one.
   */
  var epoch = Date.now();

  function makeFrameScheduler(win) {
    var timers = {};
    var next = 1;

    return {
      request: function (callback) {
        var handle = next++;
        timers[handle] = win.setTimeout(function () {
          delete timers[handle];
          callback(Date.now() - epoch);
        }, 16);
        return handle;
      },
      cancel: function (handle) {
        if (Object.prototype.hasOwnProperty.call(timers, handle)) {
          win.clearTimeout(timers[handle]);
          delete timers[handle];
        }
      }
    };
  }

  return {
    makeStorage: makeStorage,
    makeFrameScheduler: makeFrameScheduler
  };
}());

/* Hand the exports back as this program's completion value. Neither a var
 * binding nor a bare assignment made here reaches the object that page
 * scripts resolve names against, because the file is evaluated as an eval
 * program against the global the Window replaced, so dukky installs them
 * from C instead. install() is handed that object so the polyfill can reach
 * the timer functions the same way page script does.
 */
({
  drain: NetSurfPromiseSupport.drain,

  install: function (win) {
    var frames = NetSurfHostSupport.makeFrameScheduler(win);

    return {
      Promise: NetSurfPromiseSupport.promise,
      localStorage: NetSurfHostSupport.makeStorage(),
      sessionStorage: NetSurfHostSupport.makeStorage(),
      requestAnimationFrame: function (callback) {
        return frames.request(callback);
      },
      cancelAnimationFrame: function (handle) {
        frames.cancel(handle);
      }
    };
  }
});
