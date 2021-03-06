module.exports = HTTPTracker

var bencode = require('bencode')
var compact2string = require('compact2string')
var debug = require('debug')('bittorrent-tracker:http-tracker')
var EventEmitter = require('events').EventEmitter
var get = require('simple-get')
var inherits = require('inherits')

var common = require('./common')

var HTTP_SCRAPE_SUPPORT = /\/(announce)[^\/]*$/

inherits(HTTPTracker, EventEmitter)

/**
 * HTTP torrent tracker client (for an individual tracker)
 *
 * @param {Client} client       parent bittorrent tracker client
 * @param {string} announceUrl  announce url of tracker
 * @param {Object} opts         options object
 */
function HTTPTracker (client, announceUrl, opts) {
  var self = this
  EventEmitter.call(self)
  debug('new http tracker %s', announceUrl)

  self.client = client

  self._opts = opts
  self._announceUrl = announceUrl
  self._intervalMs = self.client._intervalMs // use client interval initially
  self._interval = null

  // Determine scrape url (if http tracker supports it)
  self._scrapeUrl = null
  var m
  if ((m = self._announceUrl.match(HTTP_SCRAPE_SUPPORT))) {
    self._scrapeUrl = self._announceUrl.slice(0, m.index) + '/scrape' +
      self._announceUrl.slice(m.index + 9)
  }
}

HTTPTracker.prototype.announce = function (opts) {
  var self = this
  if (self._trackerId) opts.trackerid = self._trackerId

  if (opts.compact == null) opts.compact = 1
  if (opts.numwant == null) opts.numwant = self.client._numWant // spec says 'numwant'

  opts.info_hash = self.client._infoHash.toString('binary')
  opts.peer_id = self.client._peerId.toString('binary')
  opts.port = self.client._port

  self._request(self._announceUrl, opts, self._onAnnounceResponse.bind(self))
}

HTTPTracker.prototype.scrape = function (opts) {
  var self = this

  if (!self._scrapeUrl) {
    self.client.emit('error', new Error('scrape not supported ' + self._announceUrl))
    return
  }

  opts.info_hash = (Array.isArray(opts.infoHash) && opts.infoHash.length > 0)
    ? opts.infoHash.map(function (infoHash) { return infoHash.toString('binary') })
    : (opts.infoHash || self.client._infoHash).toString('binary')

  if (opts.infoHash) delete opts.infoHash

  self._request(self._scrapeUrl, opts, self._onScrapeResponse.bind(self))
}

// TODO: Improve this interface
HTTPTracker.prototype.setInterval = function (intervalMs) {
  var self = this
  clearInterval(self._interval)

  self._intervalMs = intervalMs
  if (intervalMs) {
    // HACK
    var update = self.announce.bind(self, self.client._defaultAnnounceOpts())
    self._interval = setInterval(update, self._intervalMs)
  }
}

HTTPTracker.prototype._request = function (requestUrl, opts, cb) {
  var self = this

  var u = requestUrl + (requestUrl.indexOf('?') === -1 ? '?' : '&') +
    common.querystringStringify(opts)

  get.concat(u, function (err, data, res) {
    if (err) return self.client.emit('warning', err)
    if (res.statusCode !== 200) {
      return self.client.emit('warning', new Error('Non-200 response code ' +
        res.statusCode + ' from ' + self._announceUrl))
    }
    if (!data || data.length === 0) {
      return self.client.emit('warning', new Error('Invalid tracker response from' +
        self._announceUrl))
    }

    try {
      data = bencode.decode(data)
    } catch (err) {
      return self.client.emit('warning', new Error('Error decoding tracker response: ' + err.message))
    }
    var failure = data['failure reason']
    if (failure) {
      debug('failure from ' + requestUrl + ' (' + failure + ')')
      return self.client.emit('warning', new Error(failure))
    }

    var warning = data['warning message']
    if (warning) {
      debug('warning from ' + requestUrl + ' (' + warning + ')')
      self.client.emit('warning', new Error(warning))
    }

    debug('response from ' + requestUrl)

    cb(data)
  })
}

HTTPTracker.prototype._onAnnounceResponse = function (data) {
  var self = this

  var interval = data.interval || data['min interval']
  if (interval && !self._opts.interval && self._intervalMs !== 0) {
    // use the interval the tracker recommends, UNLESS the user manually specifies an
    // interval they want to use
    self.setInterval(interval * 1000)
  }

  var trackerId = data['tracker id']
  if (trackerId) {
    // If absent, do not discard previous trackerId value
    self._trackerId = trackerId
  }

  self.client.emit('update', {
    announce: self._announceUrl,
    complete: data.complete,
    incomplete: data.incomplete
  })

  var addrs
  if (Buffer.isBuffer(data.peers)) {
    // tracker returned compact response
    try {
      addrs = compact2string.multi(data.peers)
    } catch (err) {
      return self.client.emit('warning', err)
    }
    addrs.forEach(function (addr) {
      self.client.emit('peer', addr)
    })
  } else if (Array.isArray(data.peers)) {
    // tracker returned normal response
    data.peers.forEach(function (peer) {
      self.client.emit('peer', peer.ip + ':' + peer.port)
    })
  }

  if (Buffer.isBuffer(data.peers6)) {
    // tracker returned compact response
    try {
      addrs = compact2string.multi6(data.peers6)
    } catch (err) {
      return self.client.emit('warning', err)
    }
    addrs.forEach(function (addr) {
      self.client.emit('peer', addr)
    })
  } else if (Array.isArray(data.peers6)) {
    // tracker returned normal response
    data.peers6.forEach(function (peer) {
      var ip = /^\[/.test(peer.ip) || !/:/.test(peer.ip)
        ? peer.ip /* ipv6 w/ brackets or domain name */
        : '[' + peer.ip + ']' /* ipv6 without brackets */
      self.client.emit('peer', ip + ':' + peer.port)
    })
  }
}

HTTPTracker.prototype._onScrapeResponse = function (data) {
  var self = this
  // NOTE: the unofficial spec says to use the 'files' key, 'host' has been
  // seen in practice
  data = data.files || data.host || {}

  var keys = Object.keys(data)
  if (keys.length === 0) {
    self.client.emit('warning', new Error('invalid scrape response'))
    return
  }

  keys.forEach(function (infoHash) {
    var response = data[infoHash]
    // TODO: optionally handle data.flags.min_request_interval
    // (separate from announce interval)
    self.client.emit('scrape', {
      announce: self._announceUrl,
      infoHash: common.binaryToHex(infoHash),
      complete: response.complete,
      incomplete: response.incomplete,
      downloaded: response.downloaded
    })
  })
}
