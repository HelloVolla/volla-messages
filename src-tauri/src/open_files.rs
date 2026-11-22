//! Raise the limit on open files before Holochain starts.
//!
//! Holochain keeps four databases per conversation, each with several
//! connections, so an account with many conversations needs far more open
//! files than the 1024 Linux gives an app by default: 16 conversations already
//! peaked at about 990 at start-up. Past the limit, databases fail to open
//! ("unable to open database file") and the window's web process dies, leaving
//! a white window.
//!
//! Only the soft limit is raised, up to the hard limit, which needs no
//! privileges.

use std::sync::OnceLock;

/// What `raise_limit` did. It runs before the log plugin exists, when `log`
/// macros are dropped, so the outcome is kept here and reported by
/// `report_outcome` once logging works.
static OUTCOME: OnceLock<String> = OnceLock::new();

/// Linux refuses a soft limit above `fs.nr_open`, which defaults to this.
#[cfg(all(unix, any(not(target_os = "macos"), test)))]
const LINUX_CAP: u64 = 1 << 20;

/// macOS's traditional per-process maximum, used when it cannot be queried or
/// a larger value is refused.
#[cfg(target_os = "macos")]
const MACOS_FALLBACK: u64 = 10_240;

/// Raise the soft limit on open files. Call before the conductor starts.
pub fn raise_limit() {
    #[cfg(unix)]
    {
        let outcome = match raise() {
            Ok((old, new)) if new > old => format!("open file limit raised from {old} to {new}"),
            Ok((old, _)) => format!("open file limit left at {old}"),
            Err(e) => format!("could not raise the open file limit: {e}"),
        };
        let _ = OUTCOME.set(outcome);
    }
}

/// Log what `raise_limit` did. Call once the log plugin is up.
pub fn report_outcome() {
    if let Some(outcome) = OUTCOME.get() {
        log::info!("[startup] {outcome}");
    }
}

/// The soft limit to ask for, or `None` when the current one is already as
/// high as allowed.
#[cfg(unix)]
fn target_limit(current: u64, hard: u64, cap: u64) -> Option<u64> {
    let target = hard.min(cap);
    (target > current).then_some(target)
}

/// Returns the soft limit before and after.
#[cfg(unix)]
fn raise() -> std::io::Result<(u64, u64)> {
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: `limit` is a valid, writable rlimit.
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    let current = limit.rlim_cur as u64;

    let Some(target) = target_limit(current, limit.rlim_max as u64, platform_cap()) else {
        return Ok((current, current));
    };

    match set_soft_limit(&mut limit, target) {
        Ok(()) => Ok((current, target)),
        #[cfg(target_os = "macos")]
        Err(_) if target > MACOS_FALLBACK && MACOS_FALLBACK > current => {
            set_soft_limit(&mut limit, MACOS_FALLBACK)?;
            Ok((current, MACOS_FALLBACK))
        }
        Err(e) => Err(e),
    }
}

#[cfg(unix)]
fn set_soft_limit(limit: &mut libc::rlimit, soft: u64) -> std::io::Result<()> {
    limit.rlim_cur = soft as libc::rlim_t;
    // SAFETY: `limit` is a valid rlimit; only the soft limit changes.
    if unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, limit) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn platform_cap() -> u64 {
    LINUX_CAP
}

/// macOS refuses "unlimited" and anything above `kern.maxfilesperproc`.
#[cfg(target_os = "macos")]
fn platform_cap() -> u64 {
    let mut value: libc::c_int = 0;
    let mut size = std::mem::size_of::<libc::c_int>();
    // SAFETY: the name is NUL-terminated and `value`/`size` describe a c_int.
    let ok = unsafe {
        libc::sysctlbyname(
            c"kern.maxfilesperproc".as_ptr(),
            &mut value as *mut libc::c_int as *mut libc::c_void,
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    } == 0;
    if ok && value > 0 {
        value as u64
    } else {
        MACOS_FALLBACK
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn raises_up_to_the_hard_limit() {
        assert_eq!(target_limit(1024, 524_288, LINUX_CAP), Some(524_288));
    }

    #[test]
    fn never_asks_for_more_than_the_platform_allows() {
        // An "unlimited" hard limit is reported as the largest value.
        assert_eq!(target_limit(1024, u64::MAX, LINUX_CAP), Some(LINUX_CAP));
        assert_eq!(target_limit(256, u64::MAX, 61_440), Some(61_440));
    }

    #[test]
    fn leaves_a_limit_that_is_already_high_enough() {
        assert_eq!(target_limit(65_536, 65_536, LINUX_CAP), None);
        assert_eq!(target_limit(65_536, 1_048_576, 10_240), None);
    }

    #[test]
    fn raises_the_limit_of_this_process() {
        let (old, new) = raise().unwrap();
        assert!(new >= old);

        let mut limit = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        assert_eq!(unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) }, 0);
        assert_eq!(limit.rlim_cur as u64, new);
        // Calling it again changes nothing.
        assert_eq!(raise().unwrap(), (new, new));
    }
}
