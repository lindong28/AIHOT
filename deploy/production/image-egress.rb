#!/usr/bin/env ruby
# Mac Studio only: persist the approved AIHOT image route in the active local
# Clash profile, then reload the same runtime. Other settings remain byte-identical.
require 'yaml'
require 'json'
require 'fileutils'
require 'open3'
require 'digest'

RULE = 'AND,((DOMAIN,pbs.twimg.com),(NETWORK,tcp)),Tencent-SG'
APP = File.expand_path('~/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev')
STATE = File.expand_path('~/.local/state/aihot-image-egress')
SOCKET = '/tmp/verge/verge-mihomo.sock'
def api(path, body = nil)
  args = ['curl', '--silent', '--show-error', '--fail', '--max-time', '20', '--unix-socket', SOCKET]
  args += ['-X', 'PUT', '-H', 'Content-Type: application/json', '--data-binary', JSON.generate(body)] if body
  out, _, status = Open3.capture3(*args, 'http://localhost' + path)
  raise 'Clash controller request failed; inspect the saved recovery state' unless status.success?
  out.empty? ? nil : JSON.parse(out)
end
def write_private(path, bytes)
  staging = path + '.aihot-next'
  raise 'Unexpected staging file; preserve it' if File.exist?(staging) || File.symlink?(staging)
  File.open(staging, File::WRONLY | File::CREAT | File::EXCL, 0600) { |f| f.write(bytes); f.flush; f.fsync }
  File.rename(staging, path)
end
def active_profile
  registry = YAML.load_file(File.join(APP, 'profiles.yaml'))
  entries = registry.fetch('items').select { |x| x['uid'] == registry['current'] }
  raise 'Active profile must be one local profile' unless entries.length == 1 && entries[0]['type'] == 'local'
  name = entries[0].fetch('file')
  raise 'Unexpected active profile path' unless File.basename(name) == name && !name.include?('\\')
  File.join(APP, 'profiles', name)
end
def patched(bytes)
  doc = YAML.safe_load(bytes)
  rules = doc.fetch('rules')
  raise 'Tencent-SG is absent' unless doc.fetch('proxies').any? { |p| p['name'] == 'Tencent-SG' }
  return bytes if rules.first == RULE && rules.count(RULE) == 1
  raise 'Existing image rule differs; preserve it' if rules.any? { |r| r.include?('pbs.twimg.com') }
  raise 'Expected exactly one block-style rules header' unless bytes.scan(/^rules:\r?$/).length == 1
  section = bytes.split(/^rules:\r?$/, 2).last
  first_rule = section.lines.find { |line| line.match?(/^\s*-/) }
  raise 'Expected a block rule list' unless first_rule
  indent = first_rule[/^ */]
  after = bytes.sub(/^rules:\r?$/, "rules:\n#{indent}- #{RULE}")
  expected = doc.merge('rules' => [RULE] + rules)
  raise 'Patch changed unrelated settings' unless YAML.safe_load(after) == expected
  after
end

begin
  raise 'Only Mac Studio is authorized' unless `scutil --get LocalHostName`.strip == 'macstudio'
  owner = File.read(File.expand_path('~/.config/agent-proxy/clash-managed')).strip
  raise 'Unexpected Clash owner' unless owner == File.expand_path('~/research/system-config')
  mode = ARGV.fetch(0, 'check')
  raise 'Usage: image-egress.rb check|apply|rollback' unless %w[check apply rollback].include?(mode)
  profile = active_profile
  runtime = File.join(APP, 'clash-verge.yaml')
  paths = [profile, runtime]
  raise 'Refuse symlinked configuration or state' if (paths + [STATE]).any? { |p| File.symlink?(p) }
  before = paths.map { |p| File.binread(p) }
  after = before.map { |b| patched(b) }
  selection = api('/proxies/us-agent-group').fetch('now')
  raise 'Expected rule mode' unless api('/configs').fetch('mode') == 'rule'
  if mode == 'check'
    puts 'Ready: only pbs.twimg.com TCP routing will change. No files changed.'
    exit 0
  end
  FileUtils.mkdir_p(STATE, mode: 0700)
  File.chmod(0700, STATE)
  File.open(File.join(STATE, 'lock'), File::RDWR | File::CREAT, 0600) do |lock|
    raise 'Another image route operation is running' unless lock.flock(File::LOCK_EX | File::LOCK_NB)
    receipt_path = File.join(STATE, 'receipt.json')
    if File.exist?(receipt_path)
      receipt = JSON.parse(File.read(receipt_path))
      raise 'Active profile changed since installation' unless receipt['paths'] == paths
      original = paths.each_index.map { |i| File.binread(File.join(STATE, "before-#{i}.yaml")) }
      raise 'Backup integrity mismatch' unless original.map { |b| Digest::SHA256.hexdigest(b) } == receipt['sha256']
    else
      raise 'No installation receipt to roll back' if mode == 'rollback'
      raise 'Existing image rule has no receipt; preserve it' if before.any? { |b| YAML.safe_load(b).fetch('rules').include?(RULE) }
      original = before
      original.each_with_index { |b, i| write_private(File.join(STATE, "before-#{i}.yaml"), b) }
      write_private(receipt_path, JSON.generate({'paths' => paths, 'sha256' => original.map { |b| Digest::SHA256.hexdigest(b) }}))
    end
    desired = mode == 'rollback' ? original : after
    raise 'Configuration drifted; preserve current state' unless paths.each_index.all? { |i| before[i] == original[i] || before[i] == patched(original[i]) }
    raise 'Configuration changed during preflight' unless active_profile == profile && paths.each_index.all? { |i| File.binread(paths[i]) == before[i] }
    begin
      paths.each_with_index { |p, i| write_private(p, desired[i]) }
      api('/configs?force=true', {'path' => runtime})
      raise 'Global selector changed' unless api('/proxies/us-agent-group').fetch('now') == selection
      present = api('/rules').fetch('rules').any? { |r| r['proxy'] == 'Tencent-SG' && r['payload'].to_s.include?('pbs.twimg.com') }
      raise 'Runtime image rule not confirmed' unless present == (mode == 'apply')
    rescue
      paths.each_with_index { |p, i| write_private(p, before[i]) }
      api('/configs?force=true', {'path' => runtime})
      raise
    end
    puts "#{mode == 'apply' ? 'Installed' : 'Restored'} image route; global selector unchanged. Verify images through the production website."
  end
rescue => error
  warn "Image routing incomplete (#{error.class}); preserve configuration and inspect private recovery state."
  exit 1
end
