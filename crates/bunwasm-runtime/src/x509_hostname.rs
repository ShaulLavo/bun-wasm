// Adapted from Bun src/boringssl/lib.rs at cd95fa7a13b3f13be73e512b38ec111c1c228084.
// BoringSSL's check_host no longer implements these OpenSSL option bits.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Wildcards {
    None,
    FullLabel,
    EdgePartial,
}

pub(super) fn matches(pattern: &[u8], host: &[u8], flags: u32) -> bool {
    if pattern.is_empty() || pattern.contains(&0) || host.is_empty() {
        return false;
    }
    if host.len() > 1 && host[0] == b'.' {
        let Some(skip) = pattern.len().checked_sub(host.len()) else {
            return false;
        };
        return !(flags & 0x10 != 0 && pattern[..skip].contains(&b'.'))
            && pattern[skip..].eq_ignore_ascii_case(host);
    }
    let wildcards = if flags & 0x02 != 0 {
        Wildcards::None
    } else if flags & 0x04 != 0 {
        Wildcards::FullLabel
    } else {
        Wildcards::EdgePartial
    };
    if wildcards == Wildcards::None || !valid_pattern(pattern) {
        return pattern.eq_ignore_ascii_case(host);
    }
    let first_end = pattern
        .iter()
        .position(|&b| b == b'.')
        .unwrap_or(pattern.len());
    let first = &pattern[..first_end];
    let rest = pattern.get(first_end + 1..).unwrap_or(b"");
    let Some(star) = first.iter().position(|&b| b == b'*') else {
        return pattern.eq_ignore_ascii_case(host);
    };
    let prefix = &first[..star];
    let suffix = &first[star + 1..];
    let full_label = prefix.is_empty() && suffix.is_empty();
    if suffix.contains(&b'*')
        || rest.contains(&b'*')
        || starts_idna(first)
        || !rest.contains(&b'.')
        || (wildcards == Wildcards::FullLabel && !full_label)
        || (wildcards == Wildcards::EdgePartial && !prefix.is_empty() && !suffix.is_empty())
    {
        return pattern.eq_ignore_ascii_case(host);
    }
    let multi_label = flags & 0x08 != 0 && full_label;
    let host_first = if multi_label {
        let Some(cut) = host.len().checked_sub(rest.len() + 1) else {
            return false;
        };
        if host[cut] != b'.' || !host[cut + 1..].eq_ignore_ascii_case(rest) {
            return false;
        }
        &host[..cut]
    } else {
        let end = host.iter().position(|&b| b == b'.').unwrap_or(host.len());
        if !host
            .get(end + 1..)
            .unwrap_or(b"")
            .eq_ignore_ascii_case(rest)
        {
            return false;
        }
        &host[..end]
    };
    wildcard_span(prefix, suffix, host_first, multi_label, full_label)
}

fn starts_idna(label: &[u8]) -> bool {
    label
        .get(..4)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(b"xn--"))
}

fn wildcard_span(prefix: &[u8], suffix: &[u8], host: &[u8], multi: bool, full: bool) -> bool {
    if host.is_empty() || prefix.len() + suffix.len() > host.len() {
        return false;
    }
    let end = host.len() - suffix.len();
    if !prefix.eq_ignore_ascii_case(&host[..prefix.len()])
        || !suffix.eq_ignore_ascii_case(&host[end..])
        || (!full && starts_idna(host))
    {
        return false;
    }
    let span = &host[prefix.len()..end];
    span == b"*"
        || span
            .iter()
            .all(|&b| b.is_ascii_alphanumeric() || b == b'-' || (multi && b == b'.'))
}

fn valid_pattern(pattern: &[u8]) -> bool {
    let mut start = true;
    let mut hyphen = false;
    for &byte in pattern {
        match byte {
            b'.' => {
                if start || hyphen {
                    return false;
                }
                start = true;
            }
            b'-' => {
                if start {
                    return false;
                }
                hyphen = true;
            }
            b'*' => start = false,
            _ if byte.is_ascii_alphanumeric() => {
                start = false;
                hyphen = false;
            }
            _ => return false,
        }
    }
    !start && !hyphen
}
