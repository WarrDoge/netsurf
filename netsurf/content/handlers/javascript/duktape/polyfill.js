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


/* The ES2015 library functions Duktape 2.7 does not carry.
 *
 * Syntax it lacks cannot be polyfilled, but these are ordinary functions,
 * and modern code calls them without feature detecting first, so their
 * absence is an immediate TypeError rather than a graceful degradation.
 */
(function () {
  function def(obj, name, fn) {
    if (obj[name] !== undefined) {
      return;
    }
    try {
      Object.defineProperty(obj, name, {
        value: fn, writable: true, enumerable: false, configurable: true
      });
    } catch (e) {
      obj[name] = fn;
    }
  }

  def(Object, 'values', function (o) {
    var out = [];
    for (var k in Object(o)) {
      if (Object.prototype.hasOwnProperty.call(o, k)) { out.push(o[k]); }
    }
    return out;
  });

  def(Object, 'entries', function (o) {
    var out = [];
    for (var k in Object(o)) {
      if (Object.prototype.hasOwnProperty.call(o, k)) { out.push([k, o[k]]); }
    }
    return out;
  });

  def(Array, 'of', function () {
    return Array.prototype.slice.call(arguments);
  });

  def(Array.prototype, 'includes', function (needle, from) {
    var len = this.length >>> 0;
    var i = from | 0;
    if (i < 0) { i = Math.max(len + i, 0); }
    for (; i < len; i++) {
      /* unlike indexOf, this has to find NaN */
      if (this[i] === needle || (needle !== needle && this[i] !== this[i])) {
        return true;
      }
    }
    return false;
  });

  def(Array.prototype, 'find', function (pred, thisArg) {
    var len = this.length >>> 0;
    for (var i = 0; i < len; i++) {
      if (pred.call(thisArg, this[i], i, this)) { return this[i]; }
    }
    return undefined;
  });

  def(Array.prototype, 'findIndex', function (pred, thisArg) {
    var len = this.length >>> 0;
    for (var i = 0; i < len; i++) {
      if (pred.call(thisArg, this[i], i, this)) { return i; }
    }
    return -1;
  });

  def(Array.prototype, 'fill', function (value, start, end) {
    var len = this.length >>> 0;
    var i = start === undefined ? 0 : (start | 0);
    var last = end === undefined ? len : (end | 0);
    if (i < 0) { i = Math.max(len + i, 0); }
    if (last < 0) { last = Math.max(len + last, 0); }
    for (; i < last && i < len; i++) { this[i] = value; }
    return this;
  });

  function pad(text, length, filler, atStart) {
    text = String(text);
    length = length >> 0;
    filler = filler === undefined ? ' ' : String(filler);

    if (text.length >= length || filler === '') {
      return text;
    }

    var made = '';
    while (made.length < length - text.length) { made += filler; }
    made = made.slice(0, length - text.length);

    return atStart ? made + text : text + made;
  }

  def(String.prototype, 'padStart', function (length, filler) {
    return pad(this, length, filler, true);
  });

  def(String.prototype, 'padEnd', function (length, filler) {
    return pad(this, length, filler, false);
  });

  def(String.prototype, 'trimStart', function () {
    return String(this).replace(/^[\s﻿\xA0]+/, '');
  });

  def(String.prototype, 'trimEnd', function () {
    return String(this).replace(/[\s﻿\xA0]+$/, '');
  });
}());


/* Map, Set and their weak counterparts.
 *
 * Keys are hashed rather than searched for, so lookup does not degrade with
 * size: primitives by their value and type, objects by a non-enumerable tag
 * written on first use. An object that refuses the tag, which a host object
 * may, falls back to a linear scan.
 *
 * The weak forms hold their keys as strongly as the others do. Real
 * weakness needs engine support, and the common use, hanging data off a
 * node for as long as the page lives, does not notice.
 */
var NetSurfCollections = (function () {
  var TAG = '__nsCollectionKey';
  var counter = 0;

  function tagOf(key) {
    var type = typeof key;

    if (key === null) { return 'null'; }
    if (type === 'undefined') { return 'undef'; }
    if (type === 'string') { return 's' + key; }
    if (type === 'boolean') { return 'b' + key; }
    if (type === 'number') {
      /* NaN is its own key, and -0 and 0 are the same one */
      return (key !== key) ? 'nan' : ('n' + (key === 0 ? 0 : key));
    }

    if (Object.prototype.hasOwnProperty.call(key, TAG)) {
      return key[TAG];
    }

    var tag = 'o' + (++counter);
    try {
      Object.defineProperty(key, TAG, {
        value: tag, writable: false, enumerable: false, configurable: false
      });
    } catch (e) {
      return null; /* not taggable; the caller scans instead */
    }

    return tag;
  }

  function Store() {
    this.entries = [];   /* [key, value], in insertion order */
    this.index = {};     /* tag -> position in entries */
  }

  Store.prototype.find = function (key) {
    var tag = tagOf(key);

    if (tag !== null) {
      var at = this.index['@' + tag];
      return at === undefined ? -1 : at;
    }

    for (var i = 0; i < this.entries.length; i++) {
      if (this.entries[i][0] === key) { return i; }
    }
    return -1;
  };

  Store.prototype.set = function (key, value) {
    var at = this.find(key);

    if (at >= 0) {
      this.entries[at][1] = value;
      return;
    }

    var tag = tagOf(key);
    this.entries.push([key, value]);
    if (tag !== null) {
      this.index['@' + tag] = this.entries.length - 1;
    }
  };

  Store.prototype.remove = function (key) {
    var at = this.find(key);

    if (at < 0) { return false; }

    this.entries.splice(at, 1);

    /* positions after the hole all moved down */
    this.index = {};
    for (var i = 0; i < this.entries.length; i++) {
      var tag = tagOf(this.entries[i][0]);
      if (tag !== null) { this.index['@' + tag] = i; }
    }

    return true;
  };

  Store.prototype.clear = function () {
    this.entries = [];
    this.index = {};
  };

  function NSMap(init) {
    if (!(this instanceof NSMap)) {
      throw new TypeError("Constructor Map requires 'new'");
    }
    this._store = new Store();
    if (init !== undefined && init !== null) {
      for (var i = 0; i < init.length; i++) {
        this.set(init[i][0], init[i][1]);
      }
    }
  }

  function sized(proto) {
    try {
      Object.defineProperty(proto, 'size', {
        get: function () { return this._store.entries.length; },
        enumerable: false,
        configurable: true
      });
    } catch (e) {
      /* leave size off rather than fail to load */
    }
  }

  NSMap.prototype.get = function (key) {
    var at = this._store.find(key);
    return at < 0 ? undefined : this._store.entries[at][1];
  };
  NSMap.prototype.set = function (key, value) {
    this._store.set(key, value);
    return this;
  };
  NSMap.prototype.has = function (key) { return this._store.find(key) >= 0; };
  NSMap.prototype['delete'] = function (key) {
    return this._store.remove(key);
  };
  NSMap.prototype.clear = function () { this._store.clear(); };
  NSMap.prototype.forEach = function (fn, thisArg) {
    var all = this._store.entries.slice();
    for (var i = 0; i < all.length; i++) {
      fn.call(thisArg, all[i][1], all[i][0], this);
    }
  };
  NSMap.prototype.keys = function () {
    return this._store.entries.map(function (e) { return e[0]; });
  };
  NSMap.prototype.values = function () {
    return this._store.entries.map(function (e) { return e[1]; });
  };
  NSMap.prototype.entries = function () {
    return this._store.entries.map(function (e) { return [e[0], e[1]]; });
  };
  sized(NSMap.prototype);

  function NSSet(init) {
    if (!(this instanceof NSSet)) {
      throw new TypeError("Constructor Set requires 'new'");
    }
    this._store = new Store();
    if (init !== undefined && init !== null) {
      for (var i = 0; i < init.length; i++) { this.add(init[i]); }
    }
  }

  NSSet.prototype.add = function (value) {
    this._store.set(value, value);
    return this;
  };
  NSSet.prototype.has = function (value) {
    return this._store.find(value) >= 0;
  };
  NSSet.prototype['delete'] = function (value) {
    return this._store.remove(value);
  };
  NSSet.prototype.clear = function () { this._store.clear(); };
  NSSet.prototype.forEach = function (fn, thisArg) {
    var all = this._store.entries.slice();
    for (var i = 0; i < all.length; i++) {
      fn.call(thisArg, all[i][0], all[i][0], this);
    }
  };
  NSSet.prototype.values = function () {
    return this._store.entries.map(function (e) { return e[0]; });
  };
  NSSet.prototype.keys = NSSet.prototype.values;
  sized(NSSet.prototype);

  return { Map: NSMap, Set: NSSet };
}());


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

  /* getElementsByClassName over the same matcher.  A live HTMLCollection is
   * not what comes back -- this is the static list querySelectorAll returns
   * -- which differs only for code that holds the result across a DOM
   * change and expects it to follow.
   */
  function byClassName(root, names) {
    var parts = String(names).split(/\s+/).filter(function (n) {
      return n.length > 0;
    });

    if (parts.length === 0) {
      return [];
    }

    return queryAll(root, '.' + parts.join('.'));
  }

  if (typeof Document !== 'undefined') {
    define(Document.prototype, 'getElementsByClassName', function (names) {
      return byClassName(this, names);
    });
  }

  if (typeof Element !== 'undefined') {
    define(Element.prototype, 'getElementsByClassName', function (names) {
      return byClassName(this, names);
    });

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

/* dataset, over the element's data-* attributes.
 *
 * A Proxy rather than a snapshot object, so that a property written through
 * it reaches the attribute and a property read from it sees an attribute
 * some other code has changed.
 */
(function () {
  if (typeof HTMLElement === 'undefined' || typeof Proxy === 'undefined') {
    return;
  }

  function toAttribute(name) {
    return 'data-' + String(name).replace(/[A-Z]/g, function (c) {
      return '-' + c.toLowerCase();
    });
  }

  function toProperty(name) {
    return name.slice(5).replace(/-([a-z])/g, function (whole, c) {
      return c.toUpperCase();
    });
  }

  function makeDataset(element) {
    return new Proxy({}, {
      get: function (target, name) {
        if (typeof name !== 'string') {
          return undefined;
        }
        var value = element.getAttribute(toAttribute(name));
        return (value === null) ? undefined : value;
      },
      set: function (target, name, value) {
        element.setAttribute(toAttribute(name), String(value));
        return true;
      },
      has: function (target, name) {
        return element.hasAttribute(toAttribute(name));
      },
      deleteProperty: function (target, name) {
        element.removeAttribute(toAttribute(name));
        return true;
      },
      ownKeys: function () {
        var out = [];
        var attrs = element.attributes;
        var i;

        for (i = 0; i < attrs.length; i++) {
          if (attrs[i].name.indexOf('data-') === 0) {
            out.push(toProperty(attrs[i].name));
          }
        }

        return out;
      }
    });
  }

  Object.defineProperty(HTMLElement.prototype, 'dataset', {
    get: function () {
      return makeDataset(this);
    },
    enumerable: false,
    configurable: true
  });
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


/* XMLHttpRequest, fetch, FormData and Headers, over the host's fetch.
 *
 * The host takes a url, a method, a body and a callback, and answers with
 * the status, the content type and the body.  Two things follow from that
 * and are visible here.  A request header cannot be sent -- the cache layer
 * underneath builds its own -- so setRequestHeader records the value and
 * nothing more, and a body always goes as form encoding whatever the page
 * asked for.  And only the content type comes back, so that is the only
 * response header there is to report.
 */
var NetSurfNetworking = (function () {
  var STATUS_TEXT = {
    200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
    301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
    404: 'Not Found', 405: 'Method Not Allowed', 408: 'Request Timeout',
    410: 'Gone', 500: 'Internal Server Error', 502: 'Bad Gateway',
    503: 'Service Unavailable', 504: 'Gateway Timeout'
  };

  function statusText(status) {
    return STATUS_TEXT[status] || '';
  }

  /* A fetch of something that is not HTTP, such as a file, carries no
   * status at all, and having arrived it has succeeded.
   */
  function statusIsOk(status) {
    return status === 0 || (status >= 200 && status < 300);
  }

  function encode(pairs) {
    var out = [];
    var i;

    for (i = 0; i < pairs.length; i++) {
      out.push(encodeURIComponent(pairs[i][0]) + '=' +
               encodeURIComponent(pairs[i][1]));
    }

    return out.join('&');
  }

  function FormData() {
    this._entries = [];
  }

  FormData.prototype.append = function (name, value) {
    this._entries.push([String(name), String(value)]);
  };

  FormData.prototype.set = function (name, value) {
    this['delete'](name);
    this.append(name, value);
  };

  FormData.prototype.get = function (name) {
    var all = this.getAll(name);
    return all.length > 0 ? all[0] : null;
  };

  FormData.prototype.getAll = function (name) {
    var key = String(name);
    return this._entries.filter(function (e) {
      return e[0] === key;
    }).map(function (e) {
      return e[1];
    });
  };

  FormData.prototype.has = function (name) {
    return this.getAll(name).length > 0;
  };

  FormData.prototype['delete'] = function (name) {
    var key = String(name);
    this._entries = this._entries.filter(function (e) {
      return e[0] !== key;
    });
  };

  FormData.prototype.forEach = function (fn, self) {
    this._entries.forEach(function (e) {
      fn.call(self, e[1], e[0], this);
    }, this);
  };

  FormData.prototype.toString = function () {
    return encode(this._entries);
  };

  function Headers(init) {
    this._map = {};

    if (init instanceof Headers) {
      init.forEach(function (value, name) {
        this.append(name, value);
      }, this);
    } else if (init && typeof init === 'object') {
      Object.keys(init).forEach(function (name) {
        this.append(name, init[name]);
      }, this);
    }
  }

  Headers.prototype.append = function (name, value) {
    var key = String(name).toLowerCase();
    this._map[key] = this._map.hasOwnProperty(key) ?
      (this._map[key] + ', ' + String(value)) : String(value);
  };

  Headers.prototype.set = function (name, value) {
    this._map[String(name).toLowerCase()] = String(value);
  };

  Headers.prototype.get = function (name) {
    var key = String(name).toLowerCase();
    return this._map.hasOwnProperty(key) ? this._map[key] : null;
  };

  Headers.prototype.has = function (name) {
    return this._map.hasOwnProperty(String(name).toLowerCase());
  };

  Headers.prototype['delete'] = function (name) {
    delete this._map[String(name).toLowerCase()];
  };

  Headers.prototype.forEach = function (fn, self) {
    Object.keys(this._map).forEach(function (key) {
      fn.call(self, this._map[key], key, this);
    }, this);
  };

  function bodyText(body) {
    if (body === undefined || body === null) {
      return null;
    }
    if (typeof body === 'string') {
      return body;
    }
    return String(body);
  }

  function makeResponse(url, status, type, text) {
    var headers = new Headers();

    if (type) {
      headers.set('content-type', type);
    }

    return {
      url: url,
      type: 'basic',
      status: status,
      statusText: statusText(status),
      ok: statusIsOk(status),
      redirected: false,
      bodyUsed: false,
      headers: headers,
      text: function () {
        return Promise.resolve(text);
      },
      json: function () {
        return Promise.resolve(text).then(function (t) {
          return JSON.parse(t);
        });
      },
      clone: function () {
        return makeResponse(url, status, type, text);
      }
    };
  }

  function makeFetch(host) {
    return function fetch(input, init) {
      var options = init || {};
      var url = (input !== null && typeof input === 'object' &&
                 typeof input.url === 'string') ? input.url : String(input);
      var method = String(options.method || 'GET').toUpperCase();
      var body = bodyText(options.body);

      return new Promise(function (resolve, reject) {
        var handle = host.fetch(url, method, body,
          function (ok, status, type, text) {
            if (!ok) {
              reject(new TypeError('Failed to fetch ' + url));
              return;
            }
            resolve(makeResponse(url, status, type, text));
          });

        if (handle === undefined) {
          reject(new TypeError('Failed to fetch ' + url));
        }
      });
    };
  }

  function makeXHR(host) {
    function XMLHttpRequest() {
      this.readyState = 0;
      this.status = 0;
      this.statusText = '';
      this.responseText = '';
      this.response = '';
      this.responseType = '';
      this.responseURL = '';
      this.timeout = 0;
      this.withCredentials = false;
      this.onreadystatechange = null;
      this.onload = null;
      this.onerror = null;
      this.onabort = null;
      this.onloadend = null;
      this._method = 'GET';
      this._url = '';
      this._handle = null;
      this._sentHeaders = {};
      this._responseType = '';
      this._listeners = {};
    }

    function emit(xhr, name) {
      var event = { type: name, target: xhr, currentTarget: xhr };
      var handler = xhr['on' + name];
      var list = xhr._listeners[name];

      if (typeof handler === 'function') {
        handler.call(xhr, event);
      }

      if (list !== undefined) {
        list.slice().forEach(function (fn) {
          fn.call(xhr, event);
        });
      }
    }

    function setReadyState(xhr, state) {
      xhr.readyState = state;
      emit(xhr, 'readystatechange');
    }

    XMLHttpRequest.prototype.addEventListener = function (name, fn) {
      var key = String(name);
      if (this._listeners[key] === undefined) {
        this._listeners[key] = [];
      }
      this._listeners[key].push(fn);
    };

    XMLHttpRequest.prototype.removeEventListener = function (name, fn) {
      var list = this._listeners[String(name)];
      if (list !== undefined) {
        this._listeners[String(name)] = list.filter(function (f) {
          return f !== fn;
        });
      }
    };

    XMLHttpRequest.prototype.open = function (method, url) {
      this._method = String(method).toUpperCase();
      this._url = String(url);
      setReadyState(this, 1);
    };

    /* Recorded and not sent: see the note at the top of this section. */
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      this._sentHeaders[String(name).toLowerCase()] = String(value);
    };

    XMLHttpRequest.prototype.getResponseHeader = function (name) {
      return this._responseType &&
        String(name).toLowerCase() === 'content-type' ?
        this._responseType : null;
    };

    XMLHttpRequest.prototype.getAllResponseHeaders = function () {
      return this._responseType ?
        ('content-type: ' + this._responseType + '\r\n') : '';
    };

    XMLHttpRequest.prototype.send = function (body) {
      var xhr = this;

      this._handle = host.fetch(this._url, this._method, bodyText(body),
        function (ok, status, type, text) {
          xhr._handle = null;
          xhr.responseURL = xhr._url;
          xhr._responseType = type;
          xhr.status = ok ? status : 0;
          xhr.statusText = ok ? statusText(status) : '';
          xhr.responseText = text;

          if (xhr.responseType === 'json') {
            try {
              xhr.response = JSON.parse(text);
            } catch (e) {
              xhr.response = null;
            }
          } else {
            xhr.response = text;
          }

          setReadyState(xhr, 2);
          setReadyState(xhr, 3);
          setReadyState(xhr, 4);
          emit(xhr, ok ? 'load' : 'error');
          emit(xhr, 'loadend');
        });

      if (this._handle === undefined) {
        this._handle = null;
        setReadyState(this, 4);
        emit(this, 'error');
        emit(this, 'loadend');
      }
    };

    XMLHttpRequest.prototype.abort = function () {
      if (this._handle !== null) {
        host.abortFetch(this._handle);
        this._handle = null;
      }
      this.readyState = 0;
      emit(this, 'abort');
      emit(this, 'loadend');
    };

    XMLHttpRequest.UNSENT = 0;
    XMLHttpRequest.OPENED = 1;
    XMLHttpRequest.HEADERS_RECEIVED = 2;
    XMLHttpRequest.LOADING = 3;
    XMLHttpRequest.DONE = 4;

    XMLHttpRequest.prototype.UNSENT = 0;
    XMLHttpRequest.prototype.OPENED = 1;
    XMLHttpRequest.prototype.HEADERS_RECEIVED = 2;
    XMLHttpRequest.prototype.LOADING = 3;
    XMLHttpRequest.prototype.DONE = 4;

    return XMLHttpRequest;
  }

  return {
    install: function (host) {
      if (host === undefined || typeof host.fetch !== 'function') {
        return {};
      }

      return {
        XMLHttpRequest: makeXHR(host),
        fetch: makeFetch(host),
        FormData: FormData,
        Headers: Headers
      };
    }
  };
}());


/* matchMedia and screen, over the viewport the Window reports.
 *
 * The features here are the ones pages actually query: the width and height
 * ranges, orientation, and the colour scheme. Anything else is answered
 * false rather than guessed at. A list never changes, because there is no
 * resize event to change it on, so a listener is accepted and never called.
 */
var NetSurfMedia = (function () {
  function colourScheme(host) {
    return (host !== undefined && typeof host.colourScheme === 'function') ?
      host.colourScheme() : 'light';
  }

  function evaluateFeature(win, host, name, value) {
    var px = parseFloat(value);

    switch (name) {
    case 'min-width':
      return win.innerWidth >= px;
    case 'max-width':
      return win.innerWidth <= px;
    case 'width':
      return win.innerWidth === px;
    case 'min-height':
      return win.innerHeight >= px;
    case 'max-height':
      return win.innerHeight <= px;
    case 'height':
      return win.innerHeight === px;
    case 'orientation':
      return value === (win.innerWidth >= win.innerHeight ?
                        'landscape' : 'portrait');
    case 'prefers-color-scheme':
      return value === colourScheme(host);
    case 'prefers-reduced-motion':
      return value === 'no-preference';
    default:
      return false;
    }
  }

  function evaluateClause(win, host, clause) {
    var text = clause.trim();
    var colon;

    if (text.length === 0) {
      return true;
    }

    if (text.charAt(0) === '(') {
      text = text.replace(/^\(\s*/, '').replace(/\s*\)$/, '');
      colon = text.indexOf(':');

      if (colon < 0) {
        /* a bare feature asks whether it has any value at all */
        return evaluateFeature(win, host, text.trim(), '') !== false;
      }

      return evaluateFeature(win, host, text.slice(0, colon).trim(),
                             text.slice(colon + 1).trim());
    }

    /* a media type: this is a screen, and nothing else */
    return text === 'screen' || text === 'all';
  }

  function evaluateQuery(win, host, query) {
    return String(query).split(',').some(function (alternative) {
      var negated = false;
      var text = alternative.trim();
      var result;

      if (/^not\s+/.test(text)) {
        negated = true;
        text = text.replace(/^not\s+/, '');
      }

      result = text.split(/\s+and\s+/).every(function (clause) {
        return evaluateClause(win, host, clause);
      });

      return negated ? !result : result;
    });
  }

  function makeMatchMedia(win, host) {
    return function matchMedia(query) {
      var text = String(query);

      return {
        media: text,
        matches: evaluateQuery(win, host, text),
        onchange: null,
        addListener: function () {},
        removeListener: function () {},
        addEventListener: function () {},
        removeEventListener: function () {},
        dispatchEvent: function () { return false; }
      };
    };
  }

  function makeScreen(win) {
    var screen = {};

    ['width', 'availWidth'].forEach(function (name) {
      Object.defineProperty(screen, name, {
        get: function () { return win.innerWidth; },
        enumerable: true
      });
    });

    ['height', 'availHeight'].forEach(function (name) {
      Object.defineProperty(screen, name, {
        get: function () { return win.innerHeight; },
        enumerable: true
      });
    });

    screen.colorDepth = 24;
    screen.pixelDepth = 24;

    return screen;
  }

  return {
    makeMatchMedia: makeMatchMedia,
    makeScreen: makeScreen
  };
}());


/* URL and URLSearchParams.
 *
 * The parsing is here but the resolving is not: a relative url is handed to
 * the host, which runs it through the same parser the browser navigates
 * with, so script and browser cannot disagree about where a link points.
 */
var NetSurfURL = (function () {
  var PARTS = new RegExp(
    '^([a-z][a-z0-9+.-]*:)' +
    '(?://(?:([^:@/]*)(?::([^@/]*))?@)?([^:/?#]*)(?::(\\d+))?)?' +
    '([^?#]*)' +
    '(\\?[^#]*)?' +
    '(#.*)?$', 'i');

  function URLSearchParams(init) {
    this._entries = [];

    if (init instanceof URLSearchParams) {
      this._entries = init._entries.slice();
    } else if (typeof init === 'string') {
      init.replace(/^\?/, '').split('&').forEach(function (pair) {
        var eq;

        if (pair.length === 0) {
          return;
        }

        eq = pair.indexOf('=');
        if (eq < 0) {
          this._entries.push([decode(pair), '']);
        } else {
          this._entries.push([decode(pair.slice(0, eq)),
                              decode(pair.slice(eq + 1))]);
        }
      }, this);
    } else if (init !== undefined && init !== null) {
      Object.keys(init).forEach(function (name) {
        this._entries.push([name, String(init[name])]);
      }, this);
    }
  }

  function decode(text) {
    try {
      return decodeURIComponent(text.replace(/\+/g, ' '));
    } catch (e) {
      return text;
    }
  }

  function encode(text) {
    return encodeURIComponent(text).replace(/%20/g, '+');
  }

  URLSearchParams.prototype.append = function (name, value) {
    this._entries.push([String(name), String(value)]);
  };

  URLSearchParams.prototype.set = function (name, value) {
    this['delete'](name);
    this.append(name, value);
  };

  URLSearchParams.prototype.get = function (name) {
    var all = this.getAll(name);
    return all.length > 0 ? all[0] : null;
  };

  URLSearchParams.prototype.getAll = function (name) {
    var key = String(name);
    return this._entries.filter(function (e) {
      return e[0] === key;
    }).map(function (e) {
      return e[1];
    });
  };

  URLSearchParams.prototype.has = function (name) {
    return this.getAll(name).length > 0;
  };

  URLSearchParams.prototype['delete'] = function (name) {
    var key = String(name);
    this._entries = this._entries.filter(function (e) {
      return e[0] !== key;
    });
  };

  URLSearchParams.prototype.forEach = function (fn, self) {
    this._entries.forEach(function (e) {
      fn.call(self, e[1], e[0], this);
    }, this);
  };

  URLSearchParams.prototype.toString = function () {
    return this._entries.map(function (e) {
      return encode(e[0]) + '=' + encode(e[1]);
    }).join('&');
  };

  function makeURL(host) {
    function URL(input, base) {
      var absolute = host.resolveUrl(String(input),
                                     base === undefined ? undefined :
                                     String(base));
      var parts;

      if (typeof absolute !== 'string') {
        throw new TypeError('Invalid URL: ' + input);
      }

      parts = PARTS.exec(absolute);
      if (parts === null) {
        throw new TypeError('Invalid URL: ' + input);
      }

      this.protocol = parts[1] || '';
      this.username = parts[2] || '';
      this.password = parts[3] || '';
      this.hostname = parts[4] || '';
      this.port = parts[5] || '';
      this.pathname = parts[6] || '';
      this.hash = parts[8] || '';
      this.searchParams = new URLSearchParams(parts[7] || '');
    }

    Object.defineProperty(URL.prototype, 'host', {
      get: function () {
        return this.port ? (this.hostname + ':' + this.port) : this.hostname;
      },
      configurable: true
    });

    Object.defineProperty(URL.prototype, 'origin', {
      get: function () {
        return this.hostname ? (this.protocol + '//' + this.host) : 'null';
      },
      configurable: true
    });

    Object.defineProperty(URL.prototype, 'search', {
      get: function () {
        var query = this.searchParams.toString();
        return query.length > 0 ? ('?' + query) : '';
      },
      set: function (value) {
        this.searchParams = new URLSearchParams(String(value));
      },
      configurable: true
    });

    /* Built rather than stored, so that a change to the path or to the
     * parameters is there the next time the url is read back.
     */
    Object.defineProperty(URL.prototype, 'href', {
      get: function () {
        var authority = '';

        if (this.hostname) {
          authority = '//';
          if (this.username) {
            authority += this.username;
            if (this.password) {
              authority += ':' + this.password;
            }
            authority += '@';
          }
          authority += this.host;
        }

        return this.protocol + authority + this.pathname +
               this.search + this.hash;
      },
      configurable: true
    });

    URL.prototype.toString = function () {
      return this.href;
    };

    URL.prototype.toJSON = function () {
      return this.href;
    };

    return URL;
  }

  return {
    install: function (host) {
      if (host === undefined || typeof host.resolveUrl !== 'function') {
        return {};
      }

      return {
        URL: makeURL(host),
        URLSearchParams: URLSearchParams
      };
    }
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

  install: function (win, host) {
    var frames = NetSurfHostSupport.makeFrameScheduler(win);
    var globals = {
      Promise: NetSurfPromiseSupport.promise,
      Map: NetSurfCollections.Map,
      Set: NetSurfCollections.Set,
      /* the weak forms hold their keys strongly; see the note above */
      WeakMap: NetSurfCollections.Map,
      WeakSet: NetSurfCollections.Set,
      localStorage: NetSurfHostSupport.makeStorage(),
      sessionStorage: NetSurfHostSupport.makeStorage(),
      requestAnimationFrame: function (callback) {
        return frames.request(callback);
      },
      cancelAnimationFrame: function (handle) {
        frames.cancel(handle);
      }
    };
    globals.matchMedia = NetSurfMedia.makeMatchMedia(win, host);
    globals.screen = NetSurfMedia.makeScreen(win);

    var network = NetSurfNetworking.install(host);
    var urls = NetSurfURL.install(host);

    Object.keys(network).forEach(function (name) {
      globals[name] = network[name];
    });
    Object.keys(urls).forEach(function (name) {
      globals[name] = urls[name];
    });

    return globals;
  }
});
