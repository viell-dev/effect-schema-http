"""
SOAP/XML File Storage Service — "Ported from a .NET WCF service in 2016"

This file server uses SOAP/XML over HTTP, preserving the quirks of the original
WCF service it was ported from. The Python port was written to be bug-compatible
with the .NET original because the ERP system that consumed it could not be
changed.

Runs on port 4200. Uses only Python stdlib (http.server + xml.etree).

Historical quirks implemented:
- Custom SOAP namespace: urn:filestore:2011
- HTTP 200 for everything, outcome in SOAP fault code (0 = success)
- GET with SOAP body for file downloads (WCF used SOAP headers for everything)
- Date format: MM/dd/yyyy HH:mm:ss (US format, no timezone) — .NET DateTime.ToString()
- Single-file listing wraps in extra <Result> (WCF serializer quirk)
- File size limit in WSDL is bytes, but error message says "KB"
"""

import http.server
import json
import os
import socketserver
import uuid
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from io import BytesIO
from urllib.request import Request, urlopen
from urllib.error import URLError

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

PORT = 4200
ID_SERVER_URL = os.environ.get("ID_SERVER_URL", "http://localhost:4100")
MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB (in bytes, as the WSDL says)

# The custom SOAP namespace — preserved from the original WCF service for
# backward compatibility with other internal consumers.
NS = "urn:filestore:2011"

# ---------------------------------------------------------------------------
# In-memory file store
# ---------------------------------------------------------------------------

files: dict[str, dict] = {}
# file_id -> {
#     "id": str,
#     "name": str,
#     "content_type": str,
#     "size": int,
#     "data": bytes,
#     "owner": str,
#     "created_at": datetime,
#     "updated_at": datetime,
# }


def format_us_date(dt: datetime) -> str:
    """Format a datetime in the US format the original .NET service used.

    Quirk: the original .NET service used DateTime.ToString() which defaults to
    MM/dd/yyyy HH:mm:ss in US locale. The Python port reproduces this exactly
    because the ERP parses it with that format.
    """
    return dt.strftime("%m/%d/%Y %H:%M:%S")


def introspect_token(token: str) -> dict | None:
    """Validate an access token by calling the ID server's /introspect endpoint."""
    try:
        data = json.dumps({"token": token}).encode()
        req = Request(
            f"{ID_SERVER_URL}/introspect",
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(req, timeout=5) as resp:
            result = json.loads(resp.read())
            if result.get("active"):
                return result
    except (URLError, json.JSONDecodeError, OSError):
        pass
    return None


# ---------------------------------------------------------------------------
# SOAP helpers
# ---------------------------------------------------------------------------

def make_soap_response(body_xml: str, fault_code: int = 0, fault_string: str = "Success") -> str:
    """Build a SOAP envelope response.

    Quirk: the original WCF service always returned HTTP 200. The outcome was
    conveyed in a SOAP fault code inside the body. Code 0 means success (which
    is not how SOAP faults are supposed to work, but the .NET service did it
    this way and the ERP expects it).
    """
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:fs="{NS}">
  <soap:Body>
    <fs:Response>
      <fs:FaultCode>{fault_code}</fs:FaultCode>
      <fs:FaultString>{fault_string}</fs:FaultString>
      {body_xml}
    </fs:Response>
  </soap:Body>
</soap:Envelope>"""


def make_soap_fault(fault_code: int, fault_string: str) -> str:
    """Build an error SOAP response (still HTTP 200, per the quirk)."""
    return make_soap_response("", fault_code, fault_string)


def parse_soap_action(body: bytes) -> tuple[str | None, ET.Element | None]:
    """Parse a SOAP envelope and extract the action name and body element."""
    try:
        root = ET.fromstring(body)
        # Register our namespace for searching
        namespaces = {
            "soap": "http://schemas.xmlsoap.org/soap/envelope/",
            "fs": NS,
        }
        soap_body = root.find("soap:Body", namespaces)
        if soap_body is None:
            return None, None
        # The first child of soap:Body is the action element
        for child in soap_body:
            # Extract the local name (strip namespace)
            tag = child.tag
            if "}" in tag:
                tag = tag.split("}", 1)[1]
            return tag, child
    except ET.ParseError:
        pass
    return None, None


def extract_text(element: ET.Element, tag: str) -> str | None:
    """Extract text from a child element, trying with and without namespace."""
    # Try with namespace
    child = element.find(f"{{{NS}}}{tag}")
    if child is not None and child.text:
        return child.text
    # Try without namespace
    child = element.find(tag)
    if child is not None and child.text:
        return child.text
    return None


# ---------------------------------------------------------------------------
# SOAP action handlers
# ---------------------------------------------------------------------------

def handle_upload(action_elem: ET.Element, owner: str) -> str:
    """Handle UploadFile SOAP action.

    Expects:
        <fs:UploadFile>
            <fs:FileName>example.txt</fs:FileName>
            <fs:ContentType>text/plain</fs:ContentType>
            <fs:FileData>[base64-encoded data]</fs:FileData>
        </fs:UploadFile>
    """
    import base64

    name = extract_text(action_elem, "FileName")
    content_type = extract_text(action_elem, "ContentType") or "application/octet-stream"
    file_data_b64 = extract_text(action_elem, "FileData")

    if not name or not file_data_b64:
        return make_soap_fault(1, "FileName and FileData are required")

    try:
        data = base64.b64decode(file_data_b64)
    except Exception:
        return make_soap_fault(2, "Invalid base64 in FileData")

    # Quirk: the WSDL says max size is in bytes (MAX_FILE_SIZE), but the error
    # message says "KB". Nobody noticed the unit mismatch because the WSDL was
    # auto-generated and the error message was hand-written.
    if len(data) > MAX_FILE_SIZE:
        return make_soap_fault(
            3,
            f"File exceeds maximum size of {MAX_FILE_SIZE // 1024} KB",
        )

    file_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    files[file_id] = {
        "id": file_id,
        "name": name,
        "content_type": content_type,
        "size": len(data),
        "data": data,
        "owner": owner,
        "created_at": now,
        "updated_at": now,
    }

    body = f"""<fs:FileId>{file_id}</fs:FileId>
      <fs:FileName>{name}</fs:FileName>
      <fs:FileSize>{len(data)}</fs:FileSize>"""
    return make_soap_response(body)


def handle_download(action_elem: ET.Element) -> tuple[str, bytes | None, str | None]:
    """Handle DownloadFile SOAP action.

    Quirk: the file ID is in the SOAP body, even though this is a GET request.
    The original WCF service used SOAP headers for everything. The Python port
    kept this for downloads to avoid breaking the ERP integration.

    Returns (soap_response, file_bytes, content_type) — if file_bytes is not
    None, the caller should send the raw bytes with the given content type
    instead of the SOAP response.
    """
    file_id = extract_text(action_elem, "FileId")
    if not file_id:
        return make_soap_fault(1, "FileId is required"), None, None

    f = files.get(file_id)
    if f is None:
        return make_soap_fault(4, "File not found"), None, None

    # Return raw bytes with the file's content type
    return "", f["data"], f["content_type"]


def handle_list(action_elem: ET.Element, owner: str) -> str:
    """Handle ListFiles SOAP action.

    Quirk: three different XML shapes depending on count:
    - Zero files: <Files/> (self-closing)
    - One file: <Files><Result><File>...</File></Result></Files>
      (extra <Result> wrapper — the .NET serializer had a quirk with single-element arrays)
    - Multiple files: <Files><File>...</File><File>...</File></Files>
      (no <Result> wrapper)

    The Python port reproduces this bug because the ERP expected it.
    """
    user_files = [f for f in files.values() if f["owner"] == owner]

    if len(user_files) == 0:
        body = "<fs:Files/>"
    elif len(user_files) == 1:
        f = user_files[0]
        body = f"""<fs:Files>
        <fs:Result>
          <fs:File>
            <fs:FileId>{f["id"]}</fs:FileId>
            <fs:FileName>{f["name"]}</fs:FileName>
            <fs:ContentType>{f["content_type"]}</fs:ContentType>
            <fs:FileSize>{f["size"]}</fs:FileSize>
            <fs:LastModified>{format_us_date(f["updated_at"])}</fs:LastModified>
          </fs:File>
        </fs:Result>
      </fs:Files>"""
    else:
        file_elems = []
        for f in user_files:
            file_elems.append(f"""<fs:File>
            <fs:FileId>{f["id"]}</fs:FileId>
            <fs:FileName>{f["name"]}</fs:FileName>
            <fs:ContentType>{f["content_type"]}</fs:ContentType>
            <fs:FileSize>{f["size"]}</fs:FileSize>
            <fs:LastModified>{format_us_date(f["updated_at"])}</fs:LastModified>
          </fs:File>""")
        body = f"<fs:Files>\n        {''.join(file_elems)}\n      </fs:Files>"

    return make_soap_response(body)


def handle_metadata(action_elem: ET.Element) -> str:
    """Handle GetFileMetadata SOAP action.

    Quirk: LastModified uses MM/dd/yyyy HH:mm:ss (US format, no timezone).
    This is the .NET DateTime.ToString() default that the Python port replicated
    using strftime.
    """
    file_id = extract_text(action_elem, "FileId")
    if not file_id:
        return make_soap_fault(1, "FileId is required")

    f = files.get(file_id)
    if f is None:
        return make_soap_fault(4, "File not found")

    body = f"""<fs:Metadata>
        <fs:FileId>{f["id"]}</fs:FileId>
        <fs:FileName>{f["name"]}</fs:FileName>
        <fs:ContentType>{f["content_type"]}</fs:ContentType>
        <fs:FileSize>{f["size"]}</fs:FileSize>
        <fs:Owner>{f["owner"]}</fs:Owner>
        <fs:CreatedDate>{format_us_date(f["created_at"])}</fs:CreatedDate>
        <fs:LastModified>{format_us_date(f["updated_at"])}</fs:LastModified>
      </fs:Metadata>"""
    return make_soap_response(body)


def handle_delete(action_elem: ET.Element, owner: str) -> str:
    """Handle DeleteFile SOAP action."""
    file_id = extract_text(action_elem, "FileId")
    if not file_id:
        return make_soap_fault(1, "FileId is required")

    f = files.get(file_id)
    if f is None:
        return make_soap_fault(4, "File not found")
    if f["owner"] != owner:
        return make_soap_fault(5, "Access denied")

    del files[file_id]
    return make_soap_response(f"<fs:Deleted>true</fs:Deleted>")


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------

class SOAPHandler(http.server.BaseHTTPRequestHandler):
    """HTTP request handler that processes SOAP actions.

    Quirk: everything returns HTTP 200, even errors. The outcome is in the SOAP
    body's FaultCode element (0 = success, anything else = error).
    """

    def do_OPTIONS(self):
        """Handle CORS preflight."""
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, SOAPAction")
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    def do_GET(self):
        """Handle GET requests.

        Quirk: file downloads use GET but expect a SOAP body with the file ID.
        The WCF service used SOAP headers for everything, and the Python port
        kept that for downloads to avoid breaking the ERP integration.
        Yes, GET with a body. The server reads it.
        """
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(b"ok")
            return

        if self.path == "/wsdl":
            self._serve_wsdl()
            return

        # Read the body even on GET (the quirk)
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length) if content_length > 0 else b""

        if not body:
            self._send_soap(make_soap_fault(1, "SOAP envelope required"))
            return

        action, action_elem = parse_soap_action(body)
        if action == "DownloadFile" and action_elem is not None:
            soap_resp, file_bytes, content_type = handle_download(action_elem)
            if file_bytes is not None:
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(file_bytes)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(file_bytes)
            else:
                self._send_soap(soap_resp)
        else:
            self._send_soap(make_soap_fault(1, f"Unknown GET action: {action}"))

    def do_POST(self):
        """Handle POST requests — the main SOAP endpoint."""
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length) if content_length > 0 else b""

        if not body:
            self._send_soap(make_soap_fault(1, "SOAP envelope required"))
            return

        action, action_elem = parse_soap_action(body)
        if action is None or action_elem is None:
            self._send_soap(make_soap_fault(1, "Invalid SOAP envelope"))
            return

        # Actions that require authentication
        auth_required = {"UploadFile", "ListFiles", "DeleteFile"}

        owner = None
        if action in auth_required:
            token = self._extract_token()
            if not token:
                self._send_soap(make_soap_fault(6, "Authorization required"))
                return

            introspection = introspect_token(token)
            if introspection is None:
                self._send_soap(make_soap_fault(6, "Invalid or expired token"))
                return
            owner = introspection.get("username", introspection.get("sub", "unknown"))

        if action == "UploadFile":
            self._send_soap(handle_upload(action_elem, owner))
        elif action == "ListFiles":
            self._send_soap(handle_list(action_elem, owner))
        elif action == "GetFileMetadata":
            self._send_soap(handle_metadata(action_elem))
        elif action == "DeleteFile":
            self._send_soap(handle_delete(action_elem, owner))
        else:
            self._send_soap(make_soap_fault(1, f"Unknown action: {action}"))

    def _extract_token(self) -> str | None:
        """Extract access token from Authorization header."""
        auth = self.headers.get("Authorization", "")
        parts = auth.split(" ", 1)
        if len(parts) == 2 and parts[0].lower() in ("bearer", "token"):
            return parts[1]
        return None

    def _send_soap(self, xml_response: str):
        """Send a SOAP XML response with HTTP 200 (always 200 — the quirk)."""
        data = xml_response.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/xml; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def _serve_wsdl(self):
        """Serve a minimal WSDL.

        Quirk: the WSDL says max file size in bytes, but the error message says KB.
        """
        wsdl = f"""<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
             xmlns:fs="{NS}"
             xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
             targetNamespace="{NS}">
  <types>
    <xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
      <xs:element name="MaxFileSize" type="xs:long" fixed="{MAX_FILE_SIZE}"/>
      <!-- Note: this value is in bytes. The error message incorrectly says KB. -->
    </xs:schema>
  </types>
  <service name="FileStoreService">
    <port name="FileStorePort">
      <soap:address location="http://localhost:{PORT}/"/>
    </port>
  </service>
</definitions>"""
        data = wsdl.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/xml; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):
        """Override to add a prefix."""
        print(f"[FileServer] {args[0]} {args[1]} {args[2]}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    allow_reuse_address = True


if __name__ == "__main__":
    server = ThreadedHTTPServer(("0.0.0.0", PORT), SOAPHandler)
    print(f"File Server listening on http://localhost:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.shutdown()
