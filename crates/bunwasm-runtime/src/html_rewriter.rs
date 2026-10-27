use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use lol_html::html_content::{
    Comment, ContentType, Doctype, DocumentEnd, Element, EndTag, TextChunk, UserData,
};
use lol_html::{
    DocumentContentHandlers, ElementContentHandlers, HandlerResult, HtmlRewriter, Selector,
    Settings, SuspensionRequest,
};

use crate::data::{Args, NativeError, NativeResult, Record, Val};
use crate::natives::Table;

type Event = Rc<RefCell<Option<(usize, &'static str)>>>;
type Parser = HtmlRewriter<'static, Box<dyn FnMut(&[u8])>>;

struct Rewrite {
    parser: Parser,
    event: Event,
    output: Rc<RefCell<Vec<u8>>>,
}

#[derive(Default)]
struct Rewriters {
    next: u32,
    active: HashMap<u32, Rewrite>,
}

fn error(message: impl std::fmt::Display) -> NativeError {
    NativeError::error(message.to_string()).named("HTMLRewriterError")
}

fn selector(value: &str) -> Result<Selector, NativeError> {
    value.parse().map_err(error)
}

fn suspend(event: &Event, index: usize, kind: &'static str) -> HandlerResult {
    *event.borrow_mut() = Some((index, kind));
    Err(Box::new(SuspensionRequest))
}

fn element_handlers(
    config: &serde_json::Value,
    index: usize,
    event: &Event,
) -> ElementContentHandlers<'static> {
    let mut handlers = ElementContentHandlers::default();
    if config["element"] == true {
        let event = event.clone();
        handlers =
            handlers.element(move |_: &mut Element<'_, '_>| suspend(&event, index, "element"));
    }
    if config["comments"] == true {
        let event = event.clone();
        handlers = handlers.comments(move |_: &mut Comment<'_>| suspend(&event, index, "comments"));
    }
    if config["text"] == true {
        let event = event.clone();
        handlers = handlers.text(move |_: &mut TextChunk<'_>| suspend(&event, index, "text"));
    }
    handlers
}

fn document_handlers(
    config: &serde_json::Value,
    index: usize,
    event: &Event,
) -> DocumentContentHandlers<'static> {
    let mut handlers = DocumentContentHandlers::default();
    if config["doctype"] == true {
        let event = event.clone();
        handlers = handlers.doctype(move |_: &mut Doctype<'_>| suspend(&event, index, "doctype"));
    }
    if config["comments"] == true {
        let event = event.clone();
        handlers = handlers.comments(move |_: &mut Comment<'_>| suspend(&event, index, "comments"));
    }
    if config["text"] == true {
        let event = event.clone();
        handlers = handlers.text(move |_: &mut TextChunk<'_>| suspend(&event, index, "text"));
    }
    if config["end"] == true {
        let event = event.clone();
        handlers = handlers.end(move |_: &mut DocumentEnd<'_>| suspend(&event, index, "end"));
    }
    handlers
}

impl Rewrite {
    fn new(json: &str) -> Result<Self, NativeError> {
        let configs: Vec<serde_json::Value> = serde_json::from_str(json).map_err(error)?;
        let event = Event::default();
        let output = Rc::new(RefCell::new(Vec::new()));
        let mut settings = Settings::new();
        for (index, config) in configs.iter().enumerate() {
            if let Some(pattern) = config["selector"].as_str() {
                settings.element_content_handlers.push((
                    Cow::Owned(selector(pattern)?),
                    element_handlers(config, index, &event),
                ));
                continue;
            }
            settings
                .document_content_handlers
                .push(document_handlers(config, index, &event));
        }
        let sink = output.clone();
        let parser = HtmlRewriter::new(
            settings,
            Box::new(move |bytes: &[u8]| sink.borrow_mut().extend_from_slice(bytes))
                as Box<dyn FnMut(&[u8])>,
        );
        Ok(Self {
            parser,
            event,
            output,
        })
    }

    fn step(&mut self, action: &str, bytes: &[u8]) -> NativeResult {
        *self.event.borrow_mut() = None;
        let result = match action {
            "write" => self.parser.write(bytes),
            "end" => self.parser.end_mut(),
            "resume" => self.parser.resume(),
            _ => return Err(error("Invalid rewriter operation")),
        };
        match result {
            Ok(()) | Err(lol_html::errors::RewritingError::Suspended) => {}
            Err(err) => return Err(error(err)),
        }
        let event: Option<Val> = self.event.borrow().map(|(handler, kind)| {
            Record::new()
                .set("handler", handler as u32)
                .set("kind", kind)
                .into()
        });
        Ok(Record::new()
            .set("output", std::mem::take(&mut *self.output.borrow_mut()))
            .set("event", event)
            .into())
    }

    fn token(&mut self, a: Args<'_>) -> NativeResult {
        let action = a.str(1)?;
        let value = a.opt_str(2).unwrap_or("");
        let content_type = if a.bool(3) {
            ContentType::Html
        } else {
            ContentType::Text
        };
        if let Some(token) = self.parser.suspended_element() {
            return element_token(token, &self.event, action, value, content_type, a);
        }
        if let Some(token) = self.parser.suspended_text_chunk() {
            match action {
                "text" => return Ok(token.as_str().into()),
                "lastInTextNode" => return Ok(token.last_in_text_node().into()),
                "removed" => return Ok(token.removed().into()),
                "before" => token.before(value, content_type),
                "after" => token.after(value, content_type),
                "replace" => token.replace(value, content_type),
                "remove" => token.remove(),
                _ => return Err(error("Invalid text operation")),
            }
            return Ok(Val::Undefined);
        }
        if let Some(token) = self.parser.suspended_comment() {
            match action {
                "text" => return Ok(token.text().into()),
                "setText" => token.set_text(value).map_err(error)?,
                "removed" => return Ok(token.removed().into()),
                "before" => token.before(value, content_type),
                "after" => token.after(value, content_type),
                "replace" => token.replace(value, content_type),
                "remove" => token.remove(),
                _ => return Err(error("Invalid comment operation")),
            }
            return Ok(Val::Undefined);
        }
        if let Some(token) = self.parser.suspended_doctype() {
            return match action {
                "name" => Ok(token.name().map_or(Val::Null, Val::from)),
                "publicId" => Ok(token.public_id().map_or(Val::Null, Val::from)),
                "systemId" => Ok(token.system_id().map_or(Val::Null, Val::from)),
                "removed" => Ok(token.removed().into()),
                "remove" => {
                    token.remove();
                    Ok(Val::Undefined)
                }
                _ => Err(error("Invalid doctype operation")),
            };
        }
        if let Some(token) = self.parser.suspended_end_tag() {
            match action {
                "name" => return Ok(token.name().into()),
                "setName" => token.set_name_str(value.to_owned()),
                "before" => token.before(value, content_type),
                "after" => token.after(value, content_type),
                "remove" => token.remove(),
                _ => return Err(error("Invalid end tag operation")),
            }
            return Ok(Val::Undefined);
        }
        if let Some(token) = self.parser.suspended_document_end() {
            if action != "append" {
                return Err(error("Invalid document end operation"));
            }
            token.append(value, content_type);
            return Ok(Val::Undefined);
        }
        Err(error("This HTML token is no longer active"))
    }
}

fn element_token(
    token: &mut Element<'_, '_>,
    event: &Event,
    action: &str,
    value: &str,
    content_type: ContentType,
    a: Args<'_>,
) -> NativeResult {
    match action {
        "tagName" => return Ok(token.tag_name().into()),
        "setTagName" => token.set_tag_name(value).map_err(error)?,
        "selfClosing" => return Ok(token.is_self_closing().into()),
        "canHaveContent" => return Ok(token.can_have_content().into()),
        "namespaceURI" => return Ok(token.namespace_uri().into()),
        "removed" => return Ok(token.removed().into()),
        "attributes" => {
            return Ok(Val::Array(
                token
                    .attributes()
                    .iter()
                    .map(|attr| Val::Array(vec![attr.name().into(), attr.value().into()]))
                    .collect(),
            ));
        }
        "getAttribute" => return Ok(token.get_attribute(value).map_or(Val::Null, Val::from)),
        "hasAttribute" => return Ok(token.has_attribute(value).into()),
        "setAttribute" => token.set_attribute(value, a.str(4)?).map_err(error)?,
        "removeAttribute" => token.remove_attribute(value),
        "before" => token.before(value, content_type),
        "after" => token.after(value, content_type),
        "replace" => token.replace(value, content_type),
        "prepend" => token.prepend(value, content_type),
        "append" => token.append(value, content_type),
        "setInnerContent" => token.set_inner_content(value, content_type),
        "remove" => token.remove(),
        "removeAndKeepContent" => token.remove_and_keep_content(),
        "onEndTag" => {
            let index = a.u32(4)? as usize;
            let event = event.clone();
            let previous = token.user_data().downcast_ref::<usize>().copied();
            if token.end_tag_handlers().is_none() {
                return Err(error("No end tag."));
            }
            token.set_user_data(index);
            let handlers = token
                .end_tag_handlers()
                .ok_or_else(|| error("No end tag."))?;
            handlers.clear();
            handlers.push(Box::new(move |_: &mut EndTag<'_>| {
                suspend(&event, index, "endTag")
            }));
            return Ok(previous.map(|id| Val::from(id as u32)).into());
        }
        _ => return Err(error("Invalid element operation")),
    }
    Ok(Val::Undefined)
}

fn with_rewriter(
    rewriters: &RefCell<Rewriters>,
    a: Args<'_>,
    f: impl FnOnce(&mut Rewrite, Args<'_>) -> NativeResult,
) -> NativeResult {
    let mut table = rewriters.borrow_mut();
    let id = a.u32(0)?;
    let rewriter = table
        .active
        .get_mut(&id)
        .ok_or_else(|| error("This HTML transform is closed"))?;
    f(rewriter, a)
}

pub(crate) fn install(t: &mut Table) {
    let rewriters = Rc::new(RefCell::new(Rewriters::default()));
    t.add("htmlValidateSelector", |a| {
        selector(a.str(0)?)?;
        Ok(Val::Undefined)
    });
    let table = rewriters.clone();
    t.add("htmlCreate", move |a| {
        let rewrite = Rewrite::new(a.str(0)?)?;
        let mut table = table.borrow_mut();
        table.next += 1;
        let id = table.next;
        table.active.insert(id, rewrite);
        Ok(id.into())
    });
    let table = rewriters.clone();
    t.add("htmlStep", move |a| {
        with_rewriter(&table, a, |r, a| r.step(a.str(1)?, a.bytes(2)?))
    });
    let table = rewriters.clone();
    t.add("htmlToken", move |a| {
        with_rewriter(&table, a, Rewrite::token)
    });
    t.add("htmlClose", move |a| {
        rewriters.borrow_mut().active.remove(&a.u32(0)?);
        Ok(Val::Undefined)
    });
}
