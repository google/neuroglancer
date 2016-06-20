module.exports = function(content) {
  this.cachable && this.cachable();
  this.value = content;
  return 'module.exports = Uint8Array.from(' + JSON.stringify(Array.from(content)) + ');';
};
module.exports.raw = true;
