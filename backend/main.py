import os
import re
import json
import uuid
from datetime import datetime
from typing import Optional, List
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(Path(__file__).parent / ".env", override=True)

from fastapi import FastAPI, HTTPException, Depends, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlmodel import SQLModel, Field, Session, create_engine, select, col
from sqlalchemy import text as sql_text

# ── DB setup ────────────────────────────────────────────────────────────────

# DATA_DIR env var lets Fly.io point to the persistent volume (/data)
_DATA_DIR = os.environ.get("DATA_DIR", os.path.join(os.path.dirname(__file__), "data"))
os.makedirs(_DATA_DIR, exist_ok=True)
DATABASE_URL = f"sqlite:///{_DATA_DIR}/note-tool.db"
engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})

def get_session():
    with Session(engine) as s:
        yield s

# ── R2 config ────────────────────────────────────────────────────────────────

R2_ACCOUNT_ID = os.getenv("R2_ACCOUNT_ID", "")
R2_ACCESS_KEY = os.getenv("R2_ACCESS_KEY_ID", "")
R2_SECRET_KEY = os.getenv("R2_SECRET_ACCESS_KEY", "")
R2_BUCKET     = os.getenv("R2_BUCKET_NAME", "")
R2_PUBLIC_URL = os.getenv("R2_PUBLIC_URL", "").rstrip("/")
R2_CONFIGURED = all([R2_ACCOUNT_ID, R2_ACCESS_KEY, R2_SECRET_KEY, R2_BUCKET, R2_PUBLIC_URL])

s3_client = None
if R2_CONFIGURED:
    try:
        import boto3
        s3_client = boto3.client(
            "s3",
            endpoint_url=f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
            aws_access_key_id=R2_ACCESS_KEY,
            aws_secret_access_key=R2_SECRET_KEY,
            region_name="auto",
        )
        print("[r2] Cloudflare R2 configured")
    except ImportError:
        print("[r2] boto3 not installed — image upload disabled")
        R2_CONFIGURED = False

# ── Models ───────────────────────────────────────────────────────────────────

class Document(SQLModel, table=True):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    title: str
    subtitle: str = ""
    footer: str = ""
    origin_document_id: Optional[str] = Field(default=None, foreign_key="document.id")
    created_at: datetime = Field(default_factory=datetime.utcnow)

class Section(SQLModel, table=True):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    document_id: str = Field(foreign_key="document.id", index=True)
    order: int
    title: str

class Node(SQLModel, table=True):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    section_id: str = Field(foreign_key="section.id", index=True)
    parent_id: Optional[str] = Field(default=None, foreign_key="node.id")
    order: int
    kw: str
    say: str = ""
    original_node_id: Optional[str] = Field(default=None)  # links back to source node in origin doc

class NodeHistory(SQLModel, table=True):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    node_id: str = Field(foreign_key="node.id", index=True)
    kw: str
    say: str
    created_at: datetime = Field(default_factory=datetime.utcnow)

class Annotation(SQLModel, table=True):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    node_id: str = Field(foreign_key="node.id", index=True)
    type: str  # highlight | crossout | bookmark | note
    range_start: Optional[int] = None
    range_end: Optional[int] = None
    color: Optional[str] = None
    selected_text: Optional[str] = None
    note_body: Optional[str] = None
    is_shadow: bool = Field(default=False)
    deleted_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)

class ShadowNote(SQLModel, table=True):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    node_id: str = Field(foreign_key="node.id", index=True, unique=True)
    body: str = ""
    status: str = "empty"  # empty | partial | complete
    updated_at: datetime = Field(default_factory=datetime.utcnow)

class ShadowSession(SQLModel, table=True):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    document_id: str = Field(foreign_key="document.id", index=True)
    name: str = ""
    created_at: datetime = Field(default_factory=datetime.utcnow)

class ShadowSessionNote(SQLModel, table=True):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()), primary_key=True)
    session_id: str = Field(foreign_key="shadowsession.id", index=True)
    node_id: str = Field(foreign_key="node.id")
    body: str = ""
    status: str = "empty"

# ── Pydantic request bodies ───────────────────────────────────────────────────

class NodePatch(BaseModel):
    kw: Optional[str] = None
    say: Optional[str] = None

class AnnotationCreate(BaseModel):
    type: str
    range_start: Optional[int] = None
    range_end: Optional[int] = None
    color: Optional[str] = None
    selected_text: Optional[str] = None
    note_body: Optional[str] = None
    is_shadow: bool = False

class AnnotationPatch(BaseModel):
    note_body: Optional[str] = None
    color: Optional[str] = None
    type: Optional[str] = None

class ShadowNotePut(BaseModel):
    body: str
    status: str = "partial"

class DocumentPatch(BaseModel):
    title: str

# ── Seed logic ───────────────────────────────────────────────────────────────

def _create_nodes(session: Session, section_id: str, parent_id: Optional[str], nodes_data: list):
    for i, nd in enumerate(nodes_data):
        node = Node(section_id=section_id, parent_id=parent_id, order=i,
                    kw=nd.get("kw", ""), say=nd.get("say", ""))
        session.add(node)
        session.flush()
        if nd.get("children"):
            _create_nodes(session, section_id, node.id, nd["children"])

def seed_from_html(session: Session, html_path: str):
    with open(html_path, "r", encoding="utf-8") as f:
        content = f.read()
    config_m = re.search(r"const CONFIG\s*=\s*(\{.*?\});", content, re.DOTALL)
    data_m   = re.search(r"const DATA\s*=\s*(\[.*?\]);",   content, re.DOTALL)
    if not config_m or not data_m:
        return
    config = json.loads(config_m.group(1))
    data   = json.loads(data_m.group(1))
    doc = Document(title=config.get("title","Untitled"),
                   subtitle=config.get("subtitle",""),
                   footer=config.get("footer",""))
    session.add(doc)
    session.flush()
    for i, sec_data in enumerate(data):
        sec = Section(document_id=doc.id, order=i, title=sec_data.get("title",""))
        session.add(sec)
        session.flush()
        _create_nodes(session, sec.id, None, sec_data.get("nodes", []))
    session.commit()
    print(f"[seed] Imported '{doc.title}' (id={doc.id})")

# ── App init ─────────────────────────────────────────────────────────────────

app = FastAPI(title="NoteToolAPI")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

@app.on_event("startup")
def on_startup():
    # Schema migrations for columns added after initial release
    with engine.begin() as conn:
        for stmt in [
            "ALTER TABLE annotation ADD COLUMN is_shadow BOOLEAN NOT NULL DEFAULT 0",
            "ALTER TABLE document ADD COLUMN origin_document_id TEXT DEFAULT NULL",
            "ALTER TABLE node ADD COLUMN original_node_id TEXT DEFAULT NULL",
        ]:
            try:
                conn.execute(sql_text(stmt))
            except Exception:
                pass  # column already exists

    SQLModel.metadata.create_all(engine)

    with Session(engine) as s:
        existing = s.exec(select(Document)).first()
        if not existing:
            html = os.path.join(os.path.dirname(__file__), "..", "design-youtube-review-tree.html")
            if os.path.exists(html):
                seed_from_html(s, html)

# ── Helpers ───────────────────────────────────────────────────────────────────

def _build_node_tree(session: Session, section_id: str) -> list:
    all_nodes = session.exec(
        select(Node).where(Node.section_id == section_id).order_by(col(Node.order))
    ).all()
    by_parent: dict[Optional[str], list] = {}
    for n in all_nodes:
        by_parent.setdefault(n.parent_id, []).append(n)

    def recurse(parent_id):
        return [
            {**n.dict(), "children": recurse(n.id)}
            for n in by_parent.get(parent_id, [])
        ]
    return recurse(None)

def _get_all_node_ids(s: Session, doc_id: str) -> list:
    sections = s.exec(select(Section).where(Section.document_id == doc_id)).all()
    ids = []
    for sec in sections:
        nodes = s.exec(select(Node).where(Node.section_id == sec.id)).all()
        ids.extend(n.id for n in nodes)
    return ids

def _copy_nodes_recursive(s: Session, orig_section_id: str, shadow_section_id: str,
                           orig_parent_id: Optional[str], shadow_parent_id: Optional[str],
                           id_map: Optional[dict] = None) -> dict:
    """Returns {orig_node_id: shadow_node_id} mapping for the entire subtree."""
    if id_map is None:
        id_map = {}
    orig_nodes = s.exec(
        select(Node)
        .where(Node.section_id == orig_section_id)
        .where(Node.parent_id == orig_parent_id)
        .order_by(col(Node.order))
    ).all()
    for orig_node in orig_nodes:
        shadow_note = s.exec(select(ShadowNote).where(ShadowNote.node_id == orig_node.id)).first()
        say = shadow_note.body if (shadow_note and shadow_note.body.strip()) else ""
        shadow_node = Node(
            section_id=shadow_section_id,
            parent_id=shadow_parent_id,
            order=orig_node.order,
            kw=orig_node.kw,
            say=say,
            original_node_id=orig_node.id,
        )
        s.add(shadow_node)
        s.flush()
        id_map[orig_node.id] = shadow_node.id
        _copy_nodes_recursive(s, orig_section_id, shadow_section_id, orig_node.id, shadow_node.id, id_map)
    return id_map

# ── Routes: Documents ─────────────────────────────────────────────────────────

@app.get("/api/documents")
def list_documents(s: Session = Depends(get_session)):
    docs = s.exec(select(Document).order_by(col(Document.created_at))).all()
    result = []
    for d in docs:
        item = {
            "id": d.id, "title": d.title, "subtitle": d.subtitle,
            "origin_document_id": d.origin_document_id,
            "origin_document_title": None,
        }
        if d.origin_document_id:
            parent = s.get(Document, d.origin_document_id)
            item["origin_document_title"] = parent.title if parent else None
        result.append(item)
    return result

@app.post("/api/documents/import")
def import_document(payload: dict, s: Session = Depends(get_session)):
    config = payload.get("config", {})
    data   = payload.get("data", [])
    doc = Document(title=config.get("title","Untitled"),
                   subtitle=config.get("subtitle",""),
                   footer=config.get("footer",""))
    s.add(doc)
    s.flush()

    id_map: dict = {}

    def create_nodes_mapped(section_id: str, parent_id: Optional[str], nodes_data: list):
        for i, nd in enumerate(nodes_data):
            node = Node(section_id=section_id, parent_id=parent_id, order=i,
                        kw=nd.get("kw",""), say=nd.get("say",""))
            s.add(node)
            s.flush()
            if nd.get("_id"):
                id_map[nd["_id"]] = node.id
            if nd.get("children"):
                create_nodes_mapped(section_id, node.id, nd["children"])

    for i, sec_data in enumerate(data):
        sec = Section(document_id=doc.id, order=i, title=sec_data.get("title",""))
        s.add(sec)
        s.flush()
        create_nodes_mapped(sec.id, None, sec_data.get("nodes", []))

    for ann_data in payload.get("annotations", []):
        old_nid = ann_data.get("node_id","")
        new_nid = id_map.get(old_nid, old_nid)
        if not s.get(Node, new_nid):
            continue
        ann = Annotation(
            node_id=new_nid,
            type=ann_data.get("type","note"),
            range_start=ann_data.get("range_start"),
            range_end=ann_data.get("range_end"),
            color=ann_data.get("color"),
            selected_text=ann_data.get("selected_text"),
            note_body=ann_data.get("note_body"),
            is_shadow=ann_data.get("is_shadow", False),
        )
        s.add(ann)

    for sh_data in payload.get("shadow_notes", []):
        old_nid = sh_data.get("node_id","")
        new_nid = id_map.get(old_nid, old_nid)
        if not s.get(Node, new_nid):
            continue
        sh = ShadowNote(node_id=new_nid, body=sh_data.get("body",""), status=sh_data.get("status","empty"))
        s.add(sh)

    s.commit()
    return {"id": doc.id, "title": doc.title}

@app.get("/api/documents/{doc_id}")
def get_document(doc_id: str, s: Session = Depends(get_session)):
    doc = s.get(Document, doc_id)
    if not doc:
        raise HTTPException(404)
    sections = s.exec(
        select(Section).where(Section.document_id == doc_id).order_by(col(Section.order))
    ).all()
    d = doc.dict()
    d["origin_document_id"] = doc.origin_document_id
    return {
        **d,
        "sections": [
            {**sec.dict(), "nodes": _build_node_tree(s, sec.id)}
            for sec in sections
        ]
    }

@app.get("/api/documents/{doc_id}/export")
def export_document(doc_id: str, s: Session = Depends(get_session)):
    doc = s.get(Document, doc_id)
    if not doc:
        raise HTTPException(404)
    sections = s.exec(
        select(Section).where(Section.document_id == doc_id).order_by(col(Section.order))
    ).all()
    anns, shadows = [], []
    for sec in sections:
        nodes = s.exec(select(Node).where(Node.section_id == sec.id)).all()
        for node in nodes:
            for a in s.exec(select(Annotation).where(Annotation.node_id == node.id, Annotation.deleted_at == None)).all():
                anns.append(a.dict())
            for sh in s.exec(select(ShadowNote).where(ShadowNote.node_id == node.id)).all():
                shadows.append(sh.dict())

    def build_nodes(section_id, parent_id=None):
        rows = s.exec(
            select(Node).where(Node.section_id == section_id, Node.parent_id == parent_id).order_by(col(Node.order))
        ).all()
        return [{"kw": n.kw, "say": n.say, "_id": n.id, "children": build_nodes(section_id, n.id)} for n in rows]

    return {
        "version": 1,
        "config": {"title": doc.title, "subtitle": doc.subtitle, "footer": doc.footer},
        "data": [{"title": sec.title, "nodes": build_nodes(sec.id)} for sec in sections],
        "annotations": anns,
        "shadow_notes": shadows,
    }

@app.delete("/api/documents/{doc_id}")
def delete_document(doc_id: str, s: Session = Depends(get_session)):
    doc = s.get(Document, doc_id)
    if not doc:
        raise HTTPException(404)
    # Unlink any shadow docs that point to this document before deleting
    shadow_docs = s.exec(select(Document).where(Document.origin_document_id == doc_id)).all()
    for sd in shadow_docs:
        sd.origin_document_id = None
        s.add(sd)
    # Delete shadow sessions
    sessions = s.exec(select(ShadowSession).where(ShadowSession.document_id == doc_id)).all()
    for sess in sessions:
        for sn in s.exec(select(ShadowSessionNote).where(ShadowSessionNote.session_id == sess.id)).all():
            s.delete(sn)
        s.delete(sess)
    sections = s.exec(select(Section).where(Section.document_id == doc_id)).all()
    for sec in sections:
        nodes = s.exec(select(Node).where(Node.section_id == sec.id)).all()
        for node in nodes:
            for ann in s.exec(select(Annotation).where(Annotation.node_id == node.id)).all():
                s.delete(ann)
            for sh in s.exec(select(ShadowNote).where(ShadowNote.node_id == node.id)).all():
                s.delete(sh)
            for h in s.exec(select(NodeHistory).where(NodeHistory.node_id == node.id)).all():
                s.delete(h)
            s.delete(node)
        s.delete(sec)
    s.delete(doc)
    s.commit()
    return {"ok": True}

@app.patch("/api/documents/{doc_id}/rename")
def rename_document(doc_id: str, body: DocumentPatch, s: Session = Depends(get_session)):
    doc = s.get(Document, doc_id)
    if not doc:
        raise HTTPException(404)
    doc.title = body.title.strip()
    s.add(doc)
    s.commit()
    s.refresh(doc)
    return {"id": doc.id, "title": doc.title}

# ── Routes: Shadow docs ────────────────────────────────────────────────────────

@app.get("/api/documents/{doc_id}/shadow-docs")
def list_shadow_docs(doc_id: str, s: Session = Depends(get_session)):
    docs = s.exec(
        select(Document)
        .where(Document.origin_document_id == doc_id)
        .order_by(col(Document.created_at).desc())
    ).all()
    return [{"id": d.id, "title": d.title, "subtitle": d.subtitle,
             "created_at": d.created_at.isoformat()} for d in docs]

@app.post("/api/documents/{doc_id}/create-shadow-doc")
def create_shadow_doc(doc_id: str, s: Session = Depends(get_session)):
    original = s.get(Document, doc_id)
    if not original:
        raise HTTPException(404)

    # Version numbering: count existing shadows of this doc
    existing_count = s.exec(
        select(Document).where(Document.origin_document_id == doc_id)
    ).all().__len__()
    version_num = existing_count + 1
    shadow_title = f"{original.title}-v{version_num}"

    shadow_doc = Document(
        title=shadow_title,
        subtitle=f"Shadow of '{original.title}'",
        footer=original.footer,
        origin_document_id=doc_id,
    )
    s.add(shadow_doc)
    s.flush()

    # Build orig_node → shadow_node id map
    full_id_map: dict = {}
    sections = s.exec(
        select(Section).where(Section.document_id == doc_id).order_by(col(Section.order))
    ).all()
    for orig_sec in sections:
        shadow_sec = Section(document_id=shadow_doc.id, order=orig_sec.order, title=orig_sec.title)
        s.add(shadow_sec)
        s.flush()
        sec_map = _copy_nodes_recursive(s, orig_sec.id, shadow_sec.id, None, None)
        full_id_map.update(sec_map)

    orig_node_ids = list(full_id_map.keys())
    if orig_node_ids:
        all_anns = s.exec(
            select(Annotation)
            .where(Annotation.node_id.in_(orig_node_ids))
            .where(Annotation.deleted_at == None)
        ).all()

        # Pass 1: copy ALL is_shadow annotations (user's explicit draft work) to shadow doc,
        # then soft-delete them from the original.
        shadow_bookmarked_nodes: set = set()
        for ann in all_anns:
            if not ann.is_shadow:
                continue
            shadow_node_id = full_id_map.get(ann.node_id)
            if not shadow_node_id:
                continue
            new_ann = Annotation(
                node_id=shadow_node_id,
                type=ann.type,
                range_start=ann.range_start,
                range_end=ann.range_end,
                color=ann.color,
                selected_text=ann.selected_text,
                note_body=ann.note_body,
                is_shadow=False,
            )
            s.add(new_ann)
            if ann.type == 'bookmark':
                shadow_bookmarked_nodes.add(ann.node_id)
            ann.deleted_at = datetime.utcnow()
            s.add(ann)

        # Pass 2: inherit original bookmarks and notes (position-independent, safe to copy).
        # Highlights/crossouts are skipped — their text-range offsets are invalid after shadow edits.
        # For bookmarks, skip if a shadow bookmark already exists for that node.
        shadow_noted_nodes: set = set()  # track nodes already covered by shadow notes
        for ann in all_anns:
            if ann.is_shadow and ann.type == 'note':
                shadow_noted_nodes.add(ann.node_id)

        for ann in all_anns:
            if ann.is_shadow or ann.type not in ('bookmark', 'note'):
                continue
            if ann.type == 'bookmark' and ann.node_id in shadow_bookmarked_nodes:
                continue
            if ann.type == 'note' and ann.node_id in shadow_noted_nodes:
                continue
            shadow_node_id = full_id_map.get(ann.node_id)
            if not shadow_node_id:
                continue
            s.add(Annotation(
                node_id=shadow_node_id,
                type=ann.type,
                note_body=ann.note_body,
                is_shadow=False,
            ))

    s.commit()
    return {"id": shadow_doc.id, "title": shadow_doc.title}

@app.post("/api/documents/{doc_id}/load-shadow/{shadow_doc_id}")
def load_shadow_doc_to_draft(doc_id: str, shadow_doc_id: str, s: Session = Depends(get_session)):
    """Copy a saved shadow doc's content into the active ShadowNote records for the original doc."""
    shadow_doc = s.get(Document, shadow_doc_id)
    if not shadow_doc or shadow_doc.origin_document_id != doc_id:
        raise HTTPException(404)

    # First clear any existing is_shadow annotations on the original doc
    orig_node_ids = _get_all_node_ids(s, doc_id)
    if orig_node_ids:
        existing_shadow_anns = s.exec(
            select(Annotation)
            .where(Annotation.node_id.in_(orig_node_ids))
            .where(Annotation.is_shadow == True)
            .where(Annotation.deleted_at == None)
        ).all()
        for ann in existing_shadow_anns:
            ann.deleted_at = datetime.utcnow()
            s.add(ann)

    # Build shadow_node → orig_node map and copy content
    updated_orig_ids: set = set()
    shadow_node_to_orig: dict = {}
    shadow_sections = s.exec(select(Section).where(Section.document_id == shadow_doc_id)).all()
    for shadow_sec in shadow_sections:
        shadow_nodes = s.exec(select(Node).where(Node.section_id == shadow_sec.id)).all()
        for shadow_node in shadow_nodes:
            if not shadow_node.original_node_id:
                continue
            shadow_node_to_orig[shadow_node.id] = shadow_node.original_node_id
            updated_orig_ids.add(shadow_node.original_node_id)
            body = shadow_node.say or ""
            status = "complete" if body.strip() else "empty"
            row = s.exec(select(ShadowNote).where(ShadowNote.node_id == shadow_node.original_node_id)).first()
            if row:
                row.body = body
                row.status = status
                row.updated_at = datetime.utcnow()
            else:
                row = ShadowNote(node_id=shadow_node.original_node_id, body=body, status=status)
            s.add(row)

            # Restore shadow doc's annotations as is_shadow=True on the original nodes
            saved_anns = s.exec(
                select(Annotation)
                .where(Annotation.node_id == shadow_node.id)
                .where(Annotation.deleted_at == None)
            ).all()
            for saved_ann in saved_anns:
                new_ann = Annotation(
                    node_id=shadow_node.original_node_id,
                    type=saved_ann.type,
                    range_start=saved_ann.range_start,
                    range_end=saved_ann.range_end,
                    color=saved_ann.color,
                    selected_text=saved_ann.selected_text,
                    note_body=saved_ann.note_body,
                    is_shadow=True,
                )
                s.add(new_ann)

    # Clear shadow notes for nodes not in the shadow doc
    for nid in orig_node_ids:
        if nid not in updated_orig_ids:
            row = s.exec(select(ShadowNote).where(ShadowNote.node_id == nid)).first()
            if row and row.body:
                row.body = ""
                row.status = "empty"
                row.updated_at = datetime.utcnow()
                s.add(row)
    s.commit()
    result = []
    for nid in orig_node_ids:
        row = s.exec(select(ShadowNote).where(ShadowNote.node_id == nid)).first()
        if row:
            result.append(row.dict())
    return result

# ── Routes: Nodes ─────────────────────────────────────────────────────────────

@app.patch("/api/nodes/{node_id}")
def patch_node(node_id: str, body: NodePatch, s: Session = Depends(get_session)):
    node = s.get(Node, node_id)
    if not node:
        raise HTTPException(404)
    history = NodeHistory(node_id=node.id, kw=node.kw, say=node.say)
    s.add(history)
    if body.kw is not None:
        node.kw = body.kw
    if body.say is not None:
        node.say = body.say
    s.add(node)
    s.commit()
    s.refresh(node)
    return {**node.dict(), "history_id": history.id}

@app.get("/api/nodes/{node_id}/history")
def get_node_history(node_id: str, s: Session = Depends(get_session)):
    rows = s.exec(
        select(NodeHistory).where(NodeHistory.node_id == node_id)
        .order_by(col(NodeHistory.created_at).desc())
    ).all()
    return rows

@app.post("/api/nodes/{node_id}/history/{history_id}/restore")
def restore_node(node_id: str, history_id: str, s: Session = Depends(get_session)):
    node = s.get(Node, node_id)
    hist = s.get(NodeHistory, history_id)
    if not node or not hist or hist.node_id != node_id:
        raise HTTPException(404)
    s.add(NodeHistory(node_id=node.id, kw=node.kw, say=node.say))
    node.kw = hist.kw
    node.say = hist.say
    s.add(node)
    s.commit()
    s.refresh(node)
    return node.dict()

# ── Routes: Annotations ───────────────────────────────────────────────────────

@app.get("/api/documents/{doc_id}/annotations")
def get_annotations(doc_id: str, s: Session = Depends(get_session)):
    node_ids = _get_all_node_ids(s, doc_id)
    anns = []
    for nid in node_ids:
        rows = s.exec(
            select(Annotation).where(Annotation.node_id == nid).where(Annotation.deleted_at == None)
        ).all()
        anns.extend(rows)
    return anns

@app.post("/api/nodes/{node_id}/annotations")
def create_annotation(node_id: str, body: AnnotationCreate, s: Session = Depends(get_session)):
    if not s.get(Node, node_id):
        raise HTTPException(404)
    ann = Annotation(node_id=node_id, **body.dict())
    s.add(ann)
    s.commit()
    s.refresh(ann)
    return ann.dict()

@app.patch("/api/annotations/{ann_id}")
def patch_annotation(ann_id: str, body: AnnotationPatch, s: Session = Depends(get_session)):
    ann = s.get(Annotation, ann_id)
    if not ann or ann.deleted_at:
        raise HTTPException(404)
    if body.note_body is not None:
        ann.note_body = body.note_body
    if body.color is not None:
        ann.color = body.color
    if body.type is not None:
        ann.type = body.type
    ann.updated_at = datetime.utcnow()
    s.add(ann)
    s.commit()
    s.refresh(ann)
    return ann.dict()

@app.delete("/api/annotations/{ann_id}")
def delete_annotation(ann_id: str, s: Session = Depends(get_session)):
    ann = s.get(Annotation, ann_id)
    if not ann:
        raise HTTPException(404)
    ann.deleted_at = datetime.utcnow()
    s.add(ann)
    s.commit()
    return {"id": ann_id, "deleted": True}

@app.post("/api/annotations/{ann_id}/restore")
def restore_annotation(ann_id: str, s: Session = Depends(get_session)):
    ann = s.get(Annotation, ann_id)
    if not ann:
        raise HTTPException(404)
    ann.deleted_at = None
    s.add(ann)
    s.commit()
    s.refresh(ann)
    return ann.dict()

# ── Routes: Shadow notes ──────────────────────────────────────────────────────

@app.get("/api/documents/{doc_id}/shadow-notes")
def get_shadow_notes(doc_id: str, s: Session = Depends(get_session)):
    node_ids = _get_all_node_ids(s, doc_id)
    result = []
    for nid in node_ids:
        row = s.exec(select(ShadowNote).where(ShadowNote.node_id == nid)).first()
        if row:
            result.append(row)
    return result

@app.put("/api/nodes/{node_id}/shadow-note")
def upsert_shadow_note(node_id: str, body: ShadowNotePut, s: Session = Depends(get_session)):
    if not s.get(Node, node_id):
        raise HTTPException(404)
    row = s.exec(select(ShadowNote).where(ShadowNote.node_id == node_id)).first()
    if row:
        row.body = body.body
        row.status = body.status
        row.updated_at = datetime.utcnow()
    else:
        row = ShadowNote(node_id=node_id, body=body.body, status=body.status)
    s.add(row)
    s.commit()
    s.refresh(row)
    return row.dict()

@app.delete("/api/documents/{doc_id}/shadow-notes")
def clear_shadow_notes(doc_id: str, s: Session = Depends(get_session)):
    node_ids = _get_all_node_ids(s, doc_id)
    for nid in node_ids:
        row = s.exec(select(ShadowNote).where(ShadowNote.node_id == nid)).first()
        if row:
            row.body = ""
            row.status = "empty"
            row.updated_at = datetime.utcnow()
            s.add(row)
    # Soft-delete all is_shadow annotations for this doc's nodes
    if node_ids:
        shadow_anns = s.exec(
            select(Annotation)
            .where(Annotation.node_id.in_(node_ids))
            .where(Annotation.is_shadow == True)
            .where(Annotation.deleted_at == None)
        ).all()
        for ann in shadow_anns:
            ann.deleted_at = datetime.utcnow()
            s.add(ann)
    s.commit()
    return {"ok": True}

# ── Routes: Image upload (Cloudflare R2) ──────────────────────────────────────

@app.get("/api/r2-status")
def r2_status():
    return {"configured": R2_CONFIGURED}

@app.post("/api/upload/image")
async def upload_image(file: UploadFile = File(...)):
    if not R2_CONFIGURED or s3_client is None:
        raise HTTPException(503, detail="Image storage not configured. Set R2_* environment variables.")
    allowed = {"jpg", "jpeg", "png", "gif", "webp", "avif"}
    ext = (file.filename or "").rsplit(".", 1)[-1].lower()
    if ext not in allowed:
        raise HTTPException(400, detail=f"File type .{ext} not allowed")
    key = f"notes/{uuid.uuid4()}.{ext}"
    contents = await file.read()
    s3_client.put_object(
        Bucket=R2_BUCKET,
        Key=key,
        Body=contents,
        ContentType=file.content_type or "image/jpeg",
    )
    return {"url": f"{R2_PUBLIC_URL}/{key}"}

# ── Serve built frontend ───────────────────────────────────────────────────────

_here = os.path.dirname(__file__)
# In Docker: dist/ sits next to main.py. In local dev: ../frontend/dist/
DIST = next(
    (p for p in [
        os.path.join(_here, "dist"),
        os.path.join(_here, "..", "frontend", "dist"),
    ] if os.path.isdir(p)),
    None,
)
if DIST:
    app.mount("/assets", StaticFiles(directory=os.path.join(DIST, "assets")), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def serve_spa(full_path: str):
        return FileResponse(os.path.join(DIST, "index.html"))
