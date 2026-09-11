#!/usr/bin/env ruby
# frozen_string_literal: true

#
# Notification Service — "the 2011 bolt-on"
#
# Built during the year everyone was writing single-page applications against APIs
# designed for server-rendered pages, and it shows. It signs requests with a shared
# secret because OAuth was still an argument, it double-submits a CSRF token because the
# same endpoints were once posted to by a form, it serves JSONP because a partner
# integration predates CORS, and it prefixes its JSON with an anti-hijacking guard that
# stopped being necessary in 2011.
#
#   GET  /session               a CSRF token, two cookies, and three deprecation headers
#   GET  /notifications.json    JSON behind a )]}', guard
#   GET  /notifications.js      JSONP, for the partner that cannot do CORS
#   GET  /inbox                 JSON served as text/html, because a template rendered it
#   POST /notifications         HMAC-signed and CSRF-guarded
#   GET  /notifications/poll    long poll
#   GET  /throttled             420 Enhance Your Calm
#

require "webrick"
require "json"
require "openssl"
require "securerandom"
require "time"

PORT = 4500

# Committed to the repository in 2011 and never rotated, which is the only reason the
# partner integration still works.
SHARED_SECRET = "notify-shared-secret-2011"

# The maximum age of a signed request, in seconds.
SIGNATURE_WINDOW = 300

NOTIFICATIONS = [
  { "id" => "n-1001", "kind" => "mention", "text" => "Renée mentioned you", "createdAt" => 1_262_304_000_000, "read" => false },
  { "id" => "n-1002", "kind" => "assignment", "text" => "A task was assigned to you", "createdAt" => 1_262_390_400_000, "read" => true },
]

CSRF_TOKENS = {}
THROTTLE_COUNTS = Hash.new(0)

def cors_headers(response)
  response["Access-Control-Allow-Origin"] = "*"
  response["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
  response["Access-Control-Allow-Headers"] = "*"
  response["Access-Control-Expose-Headers"] = "*"
end

# The signature covers the method, the path, the timestamp and the body, in that order,
# separated by newlines. This is the 2011 house style: no canonical header set, no query
# string, and no versioning, so adding a query parameter to a signed request silently
# does nothing and adding a header silently does nothing either.
def expected_signature(method, path, timestamp, body)
  message = "#{method.upcase}\n#{path}\n#{timestamp}\n#{body}"
  OpenSSL::HMAC.hexdigest("SHA256", SHARED_SECRET, message)
end

def verify_signature(request)
  timestamp = request["X-Timestamp"]
  signature = request["X-Signature"]
  return "X-Timestamp and X-Signature are required" if timestamp.nil? || signature.nil?

  age = (Time.now.to_i - timestamp.to_i).abs
  return "signature timestamp is #{age}s old; the window is #{SIGNATURE_WINDOW}s" if age > SIGNATURE_WINDOW

  expected = expected_signature(request.request_method, request.path, timestamp, request.body.to_s)
  # A constant-time comparison, which the 2011 code did not have and a 2014 audit added.
  return "signature mismatch" unless OpenSSL.secure_compare(expected, signature)

  nil
end

def send_json(response, status, payload, extra = {})
  cors_headers(response)
  response.status = status
  response["Content-Type"] = "application/json"
  extra.each { |name, value| response[name] = value }
  response.body = JSON.generate(payload)
end

server = WEBrick::HTTPServer.new(
  Port: PORT,
  AccessLog: [],
  Logger: WEBrick::Log.new($stdout, WEBrick::Log::WARN),
)

server.mount_proc "/health" do |_request, response|
  cors_headers(response)
  response["Content-Type"] = "text/plain"
  response.body = "ok"
end

# ---------------------------------------------------------------------------
# GET /session — a CSRF token, two cookies, and a deprecation notice
# ---------------------------------------------------------------------------
#
# The token is double-submitted: it is set as a cookie *and* returned in the body, and a
# mutation has to echo it in a header. That works because a cross-origin attacker can
# make the browser send the cookie but cannot read it.
#
# In a browser this client is cross-origin and does not send cookies at all, so the
# cookie half is decorative and the body half is what matters — which is exactly the
# situation every single-page application that inherited a form-era API found itself in.
server.mount_proc "/session" do |_request, response|
  token = SecureRandom.hex(16)
  CSRF_TOKENS[token] = Time.now.to_i

  cors_headers(response)
  response.status = 200
  response["Content-Type"] = "application/json"
  # Two cookies in two separate Set-Cookie field lines, which is the one header that is
  # *never* legal to combine.
  response.cookies << WEBrick::Cookie.new("notify_csrf", token).tap { |cookie| cookie.path = "/" }
  response.cookies << WEBrick::Cookie.new("notify_seen", Time.now.to_i.to_s).tap { |cookie| cookie.path = "/" }
  # The service is on its way out, and says so in three different ways because each one
  # was added by a different person reading a different draft.
  response["Deprecation"] = "true"
  response["Sunset"] = (Time.now + (86_400 * 90)).httpdate
  response["Warning"] = %(299 notify-service "Use the events stream on the API server instead")
  response["Link"] = "<http://localhost:4300/api/imports>; rel=\"successor-version\""
  response.body = JSON.generate({ "csrf_token" => token, "expires_in" => 3600 })
end

# ---------------------------------------------------------------------------
# GET /notifications.json — behind an anti-hijacking guard
# ---------------------------------------------------------------------------
#
# The `)]}',` prefix makes the payload invalid JavaScript so a <script> tag cannot load
# it and read the array through an overridden Array constructor. That attack was fixed in
# browsers in 2011. The prefix has outlived it by fifteen years, and every consumer has
# to strip five bytes before parsing.
server.mount_proc "/notifications.json" do |_request, response|
  cors_headers(response)
  response.status = 200
  response["Content-Type"] = "application/json"
  response.body = ")]}',\n" + JSON.generate(NOTIFICATIONS)
end

# ---------------------------------------------------------------------------
# GET /notifications.js — JSONP
# ---------------------------------------------------------------------------
#
# For the partner whose integration predates CORS and runs in a page they do not control.
# It is a JavaScript program, not data, and the only way to read it as data is to know
# the wrapper by name and take it off.
server.mount_proc "/notifications.js" do |request, response|
  callback = request.query["callback"] || "callback"
  cors_headers(response)
  response.status = 200
  response["Content-Type"] = "application/javascript"
  response.body = "/**/ typeof #{callback} === 'function' && #{callback}(#{JSON.generate(NOTIFICATIONS)});"
end

# ---------------------------------------------------------------------------
# GET /inbox — JSON with the wrong content type
# ---------------------------------------------------------------------------
#
# The inbox was a server-rendered page until 2012, when someone replaced the template's
# contents with a JSON literal and left the rest of the controller alone. It has
# advertised itself as HTML ever since.
server.mount_proc "/inbox" do |_request, response|
  cors_headers(response)
  response.status = 200
  response["Content-Type"] = "text/html; charset=utf-8"
  response.body = JSON.generate({ "unread" => NOTIFICATIONS.count { |item| !item["read"] }, "items" => NOTIFICATIONS })
end

# ---------------------------------------------------------------------------
# POST /notifications — signed and CSRF-guarded
# ---------------------------------------------------------------------------
server.mount_proc "/notifications" do |request, response|
  if request.request_method == "OPTIONS"
    cors_headers(response)
    response.status = 204
    next
  end

  unless request.request_method == "POST"
    cors_headers(response)
    response.status = 405
    response["Allow"] = "POST"
    response["Content-Type"] = "application/json"
    response.body = JSON.generate({ "error" => "only POST is accepted here" })
    next
  end

  signature_error = verify_signature(request)
  if signature_error
    send_json(response, 401, { "error" => "invalid_signature", "detail" => signature_error })
    next
  end

  csrf = request["X-CSRF-Token"]
  unless csrf && CSRF_TOKENS.key?(csrf)
    send_json(response, 403, { "error" => "invalid_csrf", "detail" => "call GET /session and echo its token" })
    next
  end

  payload = begin
    JSON.parse(request.body.to_s)
  rescue JSON::ParserError
    nil
  end

  # `strip` was added in 2013 after a mobile client sent a text field of spaces
  # and the notification list grew a row of blanks nobody could delete.
  if payload.nil? || payload["text"].to_s.strip.empty?
    send_json(response, 422, { "error" => "invalid_payload", "detail" => "text is required" })
    next
  end

  created = {
    "id" => "n-#{SecureRandom.hex(4)}",
    "kind" => payload["kind"] || "note",
    "text" => payload["text"],
    "createdAt" => (Time.now.to_f * 1000).to_i,
    "read" => false,
  }
  NOTIFICATIONS << created

  send_json(response, 201, created, { "Location" => "/notifications/#{created['id']}" })
end

# ---------------------------------------------------------------------------
# GET /notifications/poll — long poll
# ---------------------------------------------------------------------------
#
# Written before server-sent events had browser support. It holds the connection open
# for as long as it is asked to and then answers an empty list, which is what a long poll
# does when nothing happens.
server.mount_proc "/notifications/poll" do |request, response|
  wait = [(request.query["wait"] || "5").to_i, 30].min
  sleep(wait)
  cors_headers(response)
  response.status = 200
  response["Content-Type"] = "application/json"
  response.body = JSON.generate({ "events" => [], "waited" => wait })
end

# ---------------------------------------------------------------------------
# GET /throttled — 420 Enhance Your Calm
# ---------------------------------------------------------------------------
#
# Twitter used 420 for rate limiting before 429 was standardized, and this service copied
# it from their documentation in 2011. It is not a registered status code, it is not in
# any client's idea of "transient", and it never will be.
server.mount_proc "/throttled" do |request, response|
  client = request["X-Client-Id"] || "anonymous"
  THROTTLE_COUNTS[client] += 1

  if THROTTLE_COUNTS[client] < 3
    cors_headers(response)
    response.status = 420
    response.reason_phrase = "Enhance Your Calm"
    response["Content-Type"] = "application/json"
    response["Retry-After"] = "1"
    response["X-Attempt"] = THROTTLE_COUNTS[client].to_s
    response.body = JSON.generate({ "error" => "enhance_your_calm", "attempt" => THROTTLE_COUNTS[client] })
    next
  end

  THROTTLE_COUNTS.delete(client)
  send_json(response, 200, { "ok" => true, "attempts" => 3 }, { "X-Attempt" => "3" })
end

trap("INT") { server.shutdown }
trap("TERM") { server.shutdown }

puts "Notify Service listening on http://localhost:#{PORT}"
server.start
