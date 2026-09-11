#!/usr/bin/env perl
#
# Report Gateway — "the reporting box, 1999"
#
# The oldest thing still running. It predates the API server by fifteen years and the
# identity server by twenty, and it has never been rewritten because the finance team's
# month-end process reads its fixed-width extract with a COBOL copybook that nobody has
# the source for any more.
#
# What it does:
#   GET  /cgi-bin/login.pl?user=&pass=   credentials in a query string, session out
#   POST /cgi-bin/rpc.pl                 XML-RPC, always HTTP 200, faults in the body
#   GET  /cgi-bin/report.pl?rpt=         fixed-width records in ISO-8859-1, no delimiters
#   GET  /cgi-bin/export.pl?rpt=         CSV with a UTF-8 BOM, CRLF, and semicolons
#   GET  /health                         because the start script needs one
#
# Everything answers 200. Failures are an ERROR line, an XML-RPC <fault>, or an
# X-Error-Code header, depending on which decade the endpoint is from.

use strict;
use warnings;
use IO::Socket::INET;
use MIME::Base64 qw(encode_base64);
use POSIX qw(strftime);

my $PORT = 4400;

# The nightly extract. The gateway reads a dump produced at 02:00 and has no connection
# to the live system at all, which is why finance and engineering never agree on a number.
my @TASKS = (
    { id => 'T0000001', title => 'Migrate Löhne ledger',      status => 3, date => '20260908', amount => 1234500, active => 'Y' },
    { id => 'T0000002', title => 'Rückstellungen review',     status => 1, date => '20260909', amount =>   98750, active => 'Y' },
    { id => 'T0000003', title => 'Année fiscale closeout',    status => 0, date => '20260910', amount => 4500000, active => 'N' },
    { id => 'T0000004', title => 'Sofortmaßnahme: audit fix', status => 2, date => '20260911', amount =>       0, active => 'Y' },
);

my %SESSIONS;

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

sub url_decode {
    my ($value) = @_;
    return '' unless defined $value;
    $value =~ tr/+/ /;
    $value =~ s/%([0-9A-Fa-f]{2})/chr(hex($1))/ge;
    return $value;
}

sub parse_query {
    my ($query) = @_;
    my %params;
    return %params unless defined $query && length $query;
    for my $pair (split /&/, $query) {
        my ($key, $value) = split /=/, $pair, 2;
        # A bare key with no "=" is recorded as an empty string, which is how every CGI
        # script written in this style behaved.
        $params{ url_decode($key) } = defined $value ? url_decode($value) : '';
    }
    return %params;
}

sub new_session {
    my ($user) = @_;
    my $id = sprintf('%08X%08X', int(rand(0xFFFFFFFF)), time());
    $SESSIONS{$id} = { user => $user, created => time() };
    return $id;
}

sub valid_session {
    my ($id) = @_;
    return defined $id && length $id && exists $SESSIONS{$id};
}

sub send_response {
    my ($client, $status, $reason, $headers, $body) = @_;
    my $length = length($body);
    my $head = "HTTP/1.0 $status $reason\r\n";
    $head .= "Server: NCSA/1.5 (report-gateway)\r\n";
    $head .= "Date: " . strftime('%a, %d %b %Y %H:%M:%S GMT', gmtime()) . "\r\n";
    $head .= "Content-Length: $length\r\n";
    # Written once in 1999 and never narrowed, which is why the client can read every
    # header this service sends.
    $head .= "Access-Control-Allow-Origin: *\r\n";
    $head .= "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n";
    $head .= "Access-Control-Allow-Headers: *\r\n";
    $head .= "Access-Control-Expose-Headers: *\r\n";
    for my $header (@$headers) {
        $head .= "$header->[0]: $header->[1]\r\n";
    }
    $head .= "\r\n";
    print $client $head;
    print $client $body;
}

# ---------------------------------------------------------------------------
# GET /cgi-bin/login.pl — credentials in the query string
# ---------------------------------------------------------------------------
#
# This is how it was done. The form was a GET because the author had not yet met a POST,
# and the password is therefore in the access log, the proxy log, and the referrer of
# every link on the page that follows. It is kept exactly as it is because two scheduled
# jobs still call it with a wget command that lives in a crontab.
sub handle_login {
    my ($client, $params) = @_;
    my $user = $params->{user} || '';
    my $pass = $params->{pass} || '';

    if ($user eq '' || $pass eq '') {
        # Quirk: a failure is still a 200. The error is the first field of a
        # pipe-delimited line, which is the only error format this service has.
        send_response($client, 200, 'OK', [['Content-Type', 'text/plain']],
            "ERROR|E001|user and pass are required\n");
        return;
    }

    # Any non-empty password is accepted. The real authentication was the firewall.
    my $session = new_session($user);
    send_response($client, 200, 'OK',
        [['Content-Type', 'text/plain'], ['X-Session-Id', $session]],
        "OK|SESSION|$session|USER|$user\n");
}

# ---------------------------------------------------------------------------
# POST /cgi-bin/rpc.pl — XML-RPC
# ---------------------------------------------------------------------------

sub xml_escape {
    my ($value) = @_;
    $value =~ s/&/&amp;/g;
    $value =~ s/</&lt;/g;
    $value =~ s/>/&gt;/g;
    return $value;
}

# XML-RPC's own date format: no separators in the date, colons in the time, and no
# timezone at all. The specification is from 1998 and has never been revised.
sub rpc_datetime {
    my ($epoch) = @_;
    return strftime('%Y%m%dT%H:%M:%S', gmtime($epoch));
}

sub task_struct {
    my ($task) = @_;
    # <i4> rather than <int>: both are legal and this service picked the older spelling.
    return
        "<struct>"
      . "<member><name>id</name><value><string>" . xml_escape($task->{id}) . "</string></value></member>"
      . "<member><name>title</name><value><string>" . xml_escape($task->{title}) . "</string></value></member>"
      . "<member><name>status</name><value><i4>$task->{status}</i4></value></member>"
      . "<member><name>amount</name><value><double>" . sprintf('%.2f', $task->{amount} / 100) . "</double></value></member>"
      . "<member><name>active</name><value><boolean>" . ($task->{active} eq 'Y' ? 1 : 0) . "</boolean></value></member>"
      . "<member><name>extracted</name><value><dateTime.iso8601>" . rpc_datetime(time()) . "</dateTime.iso8601></value></member>"
      . "</struct>";
}

sub rpc_fault {
    my ($code, $message) = @_;
    return
        qq{<?xml version="1.0"?>\n<methodResponse><fault><value><struct>}
      . "<member><name>faultCode</name><value><int>$code</int></value></member>"
      . "<member><name>faultString</name><value><string>" . xml_escape($message) . "</string></value></member>"
      . "</struct></value></fault></methodResponse>\n";
}

sub handle_rpc {
    my ($client, $body) = @_;

    my ($method) = $body =~ m{<methodName>\s*([^<]+?)\s*</methodName>};
    my @values = $body =~ m{<value>\s*(?:<string>)?([^<]*?)(?:</string>)?\s*</value>}g;

    if (!defined $method) {
        # Quirk: even a malformed request is HTTP 200. The XML-RPC specification says
        # faults are transported in the body, and the 1999 author read it literally.
        send_response($client, 200, 'OK', [['Content-Type', 'text/xml']],
            rpc_fault(-32700, 'parse error: no methodName'));
        return;
    }

    my $session = $values[0] // '';
    if (!valid_session($session)) {
        send_response($client, 200, 'OK', [['Content-Type', 'text/xml']],
            rpc_fault(401, 'invalid or expired session'));
        return;
    }

    if ($method eq 'report.list') {
        my $items = join('', map { "<value>" . task_struct($_) . "</value>" } @TASKS);
        send_response($client, 200, 'OK', [['Content-Type', 'text/xml']],
            qq{<?xml version="1.0"?>\n<methodResponse><params><param><value><array><data>$items</data></array></value></param></params></methodResponse>\n});
        return;
    }

    if ($method eq 'report.count') {
        my $count = scalar @TASKS;
        send_response($client, 200, 'OK', [['Content-Type', 'text/xml']],
            qq{<?xml version="1.0"?>\n<methodResponse><params><param><value><i4>$count</i4></value></param></params></methodResponse>\n});
        return;
    }

    if ($method eq 'report.fetch') {
        my $name = $values[1] // '';
        my $payload = build_fixed_width();
        # Quirk: the payload is base64 of an ISO-8859-1 byte string. XML-RPC has no way
        # to say what the bytes mean, so the copybook is the only documentation.
        my $encoded = encode_base64($payload, '');
        send_response($client, 200, 'OK', [['Content-Type', 'text/xml']],
            qq{<?xml version="1.0"?>\n<methodResponse><params><param><value><struct>}
          . "<member><name>name</name><value><string>" . xml_escape($name) . "</string></value></member>"
          . "<member><name>recordLength</name><value><i4>63</i4></value></member>"
          . "<member><name>data</name><value><base64>$encoded</base64></value></member>"
          . "</struct></value></param></params></methodResponse>\n");
        return;
    }

    send_response($client, 200, 'OK', [['Content-Type', 'text/xml']],
        rpc_fault(-32601, "method $method is not supported"));
}

# ---------------------------------------------------------------------------
# GET /cgi-bin/report.pl — the fixed-width extract
# ---------------------------------------------------------------------------
#
# The copybook, such as anyone remembers it:
#
#   01-02  record type      "01" detail, "99" trailer
#   03-10  task id
#   11-40  description      ISO-8859-1, space padded
#   41-42  status code      "00".."04"
#   43-50  date             YYYYMMDD
#   51-60  amount           zero padded, two implied decimals
#   61-61  active flag      Y/N
#   62-63  filler           two spaces
#
# There are no line terminators. Records are 63 bytes, end to end, because the tape
# format did not have any and the file format never changed.
sub build_fixed_width {
    my $out = '';
    my $total = 0;
    for my $task (@TASKS) {
        $total += $task->{amount};
        $out .= '01';
        $out .= sprintf('%-8.8s', $task->{id});
        # Latin-1 bytes. The titles contain umlauts and accents, and this is the
        # encoding the tape was written in.
        my $title = $task->{title};
        utf8::encode($title) if utf8::is_utf8($title);
        my $latin1 = '';
        # Perl source is UTF-8 here, so fold the characters down to single bytes.
        for my $char (split //, do { my $t = $task->{title}; utf8::decode($t) unless utf8::is_utf8($t); $t }) {
            my $code = ord($char);
            $latin1 .= $code < 256 ? chr($code) : '?';
        }
        $out .= sprintf('%-30.30s', $latin1);
        $out .= sprintf('%02d', $task->{status});
        $out .= $task->{date};
        $out .= sprintf('%010d', $task->{amount});
        $out .= $task->{active};
        $out .= '  ';
    }
    # The trailer: record count and a control total, both zero padded. Finance reconciles
    # against this and will notice within the hour if it is wrong.
    $out .= '99';
    $out .= sprintf('%08d', scalar @TASKS);
    $out .= sprintf('%010d', $total);
    $out .= ' ' x (63 - 2 - 8 - 10);
    return $out;
}

sub handle_report {
    my ($client, $params) = @_;
    if (!valid_session($params->{session})) {
        # Quirk: a 200 carrying an error header. The load balancer in front of this box
        # was configured to eject a node that answered anything else.
        send_response($client, 200, 'OK',
            [['Content-Type', 'text/plain'], ['X-Error-Code', 'E401']],
            "ERROR|E401|invalid or expired session\n");
        return;
    }

    if (($params->{rpt} // '') ne 'TASKS') {
        send_response($client, 200, 'OK',
            [['Content-Type', 'text/plain'], ['X-Error-Code', 'E404']],
            "ERROR|E404|no such report\n");
        return;
    }

    # Quirk: no charset. In 1999 that meant ISO-8859-1 by specification, so nobody wrote
    # one down. It has meant "guess" since 2014.
    send_response($client, 200, 'OK',
        [['Content-Type', 'text/plain'], ['X-Record-Length', '63'], ['X-Copybook', 'TASKS01']],
        build_fixed_width());
}

# ---------------------------------------------------------------------------
# GET /cgi-bin/export.pl — the spreadsheet export
# ---------------------------------------------------------------------------
#
# Added in 2004 when someone asked for "the report, but in Excel". Excel on a German
# desktop wants semicolons, CRLF, and a byte order mark, so that is what this produces,
# and it has been produced that way ever since.
sub handle_export {
    my ($client, $params) = @_;
    if (!valid_session($params->{session})) {
        send_response($client, 200, 'OK',
            [['Content-Type', 'text/plain'], ['X-Error-Code', 'E401']],
            "ERROR|E401|invalid or expired session\n");
        return;
    }

    my $csv = "\x{EF}\x{BB}\x{BF}";    # UTF-8 BOM
    $csv .= "ID;Beschreibung;Status;Datum;Betrag;Aktiv\r\n";
    for my $task (@TASKS) {
        my $title = $task->{title};
        utf8::encode($title) if utf8::is_utf8($title);
        # Decimal comma, because that is what the spreadsheet expects.
        my $amount = sprintf('%.2f', $task->{amount} / 100);
        $amount =~ s/\./,/;
        $csv .= join(';', $task->{id}, $title, $task->{status}, $task->{date}, $amount, $task->{active}) . "\r\n";
    }

    # Quirk: application/octet-stream, because in 2004 that was the reliable way to make
    # a browser download a file instead of rendering it.
    send_response($client, 200, 'OK',
        [['Content-Type', 'application/octet-stream'],
         ['Content-Disposition', 'attachment; filename="tasks.csv"']],
        $csv);
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

sub handle_connection {
    my ($client) = @_;
    my $request_line = <$client>;
    return unless defined $request_line;
    $request_line =~ s/\r?\n$//;
    my ($method, $target) = split / /, $request_line;
    return unless defined $method && defined $target;

    my %headers;
    while (my $line = <$client>) {
        $line =~ s/\r?\n$//;
        last if $line eq '';
        my ($name, $value) = split /:\s*/, $line, 2;
        $headers{ lc $name } = $value if defined $value;
    }

    my $body = '';
    if (($headers{'content-length'} // 0) > 0) {
        read($client, $body, $headers{'content-length'});
    }

    my ($path, $query) = split /\?/, $target, 2;
    my %params = parse_query($query);

    if ($method eq 'OPTIONS') {
        send_response($client, 200, 'OK', [], '');
        return;
    }

    if ($path eq '/health') {
        send_response($client, 200, 'OK', [['Content-Type', 'text/plain']], 'ok');
    } elsif ($path eq '/cgi-bin/login.pl') {
        handle_login($client, \%params);
    } elsif ($path eq '/cgi-bin/rpc.pl' && $method eq 'POST') {
        handle_rpc($client, $body);
    } elsif ($path eq '/cgi-bin/report.pl') {
        handle_report($client, \%params);
    } elsif ($path eq '/cgi-bin/export.pl') {
        handle_export($client, \%params);
    } else {
        # Quirk: even "not found" is a 200 with an error line, because the 1999 error
        # handler was a subroutine and not an HTTP status.
        send_response($client, 200, 'OK',
            [['Content-Type', 'text/plain'], ['X-Error-Code', 'E404']],
            "ERROR|E404|no such script: $path\n");
    }
}

my $server = IO::Socket::INET->new(
    LocalAddr => '0.0.0.0',
    LocalPort => $PORT,
    Proto     => 'tcp',
    Listen    => 32,
    ReuseAddr => 1,
) or die "cannot bind port $PORT: $!";

$| = 1;
print "Report Gateway listening on http://localhost:$PORT\n";

while (my $client = $server->accept()) {
    binmode($client);
    eval {
        handle_connection($client);
        1;
    } or do {
        print "[ReportGateway] error: $@";
    };
    close($client);
}
