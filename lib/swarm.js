var debug = require('debug')('bittorrent-tracker')

module.exports = Swarm

// Regard this as the default implementation of an interface that you
// need to support when overriding Server.getSwarm()
function Swarm (infoHash, server) {
  this.peers = {}
  this.complete = 0
  this.incomplete = 0
  this.emit = server.emit.bind(server)
}

Swarm.prototype.announce = function (params, cb) {
  var self = this
  var peer = self.peers[params.addr]

  // Dispatch announce event
  if (!params.event || params.event === 'empty') params.event = 'update'
  var fn = '_onAnnounce_' + params.event
  if (self[fn]) {
    self[fn](params, peer, function (err) {
      // event processed, prepare response:

      if (params.left === 0 && peer) peer.complete = true

      // send peers
      var peers = self._getPeers(params.numwant)

      cb(null, {
        complete: self.complete,
        incomplete: self.incomplete,
        peers: peers
      })
    })
  } else {
    cb(new Error('invalid event'))
  }
}

Swarm.prototype._onAnnounce_started = function (params, peer, cb) {
  if (peer) {
    debug('unexpected `started` event from peer that is already in swarm')
    return this._onAnnounce_update() // treat as an update
  }
  if (params.left === 0) this.complete += 1
  else this.incomplete += 1
  peer = this.peers[params.addr] = {
    ip: params.ip,
    port: params.port,
    peerId: params.peer_id
  }
  this.emit('start', params.addr)

  cb()
}

Swarm.prototype._onAnnounce_stopped = function (params, peer, cb) {
  if (!peer) {
    debug('unexpected `stopped` event from peer that is not in swarm')
    return // do nothing
  }
  if (peer.complete) this.complete -= 1
  else this.incomplete -= 1
  this.peers[params.addr] = null
  this.emit('stop', params.addr)

  cb()
}

Swarm.prototype._onAnnounce_completed = function (params, peer, cb) {
  if (!peer) {
    debug('unexpected `completed` event from peer that is not in swarm')
    return start() // treat as a start
  }
  if (peer.complete) {
    debug('unexpected `completed` event from peer that is already marked as completed')
    return // do nothing
  }
  this.complete += 1
  this.incomplete -= 1
  peer.complete = true
  this.emit('complete', params.addr)

  cb()
}

Swarm.prototype._onAnnounce_update = function (params, peer, cb) {
  if (!peer) {
    debug('unexpected `update` event from peer that is not in swarm')
    return start() // treat as a start
  }
  this.emit('update', params.addr)

  cb()
}

Swarm.prototype._getPeers = function (numwant) {
  var peers = []
  for (var peerId in this.peers) {
    if (peers.length >= numwant) break
    var peer = this.peers[peerId]
    if (!peer) continue // ignore null values
    peers.push({
      'peer id': peer.peerId,
      ip: peer.ip,
      port: peer.port
    })
  }
  return peers
}

Swarm.prototype.scrape = function (infoHash, params, cb) {
  cb(null, {
    complete: this.complete,
    incomplete: this.incomplete
  })
}