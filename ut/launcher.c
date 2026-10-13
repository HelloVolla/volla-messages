// Tweaking this. Unsure if I've missed something. Testing is the next natural step.

/* Confined click launcher: the ubuntu-sdk template grants exec only inside
 * the app dir, so the shell wrapper and the python display-on holder are
 * folded into this binary. */
#include <gio/gio.h>
#include <libgen.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <unistd.h>

static void scoped_xdg(const char *var, const char *home, const char *sub)
{
	char path[PATH_MAX];
	snprintf(path, sizeof(path), "%s/%s/volla-messages", home, sub);
	mkdir(path, 0700);
	setenv(var, path, 1);
}

static void hold_display_on(void)
{
	prctl(PR_SET_PDEATHSIG, SIGKILL);
	if (getppid() == 1)
		_exit(0);
	GDBusConnection *bus = g_bus_get_sync(G_BUS_TYPE_SYSTEM, NULL, NULL);
	if (!bus)
		_exit(1);
	g_dbus_connection_call_sync(bus, "com.canonical.Unity.Screen",
			"/com/canonical/Unity/Screen", "com.canonical.Unity.Screen",
			"keepDisplayOn", NULL, G_VARIANT_TYPE("(i)"),
			G_DBUS_CALL_FLAGS_NONE, -1, NULL, NULL);
	for (;;)
		pause();
}

int main(int argc, char **argv)
{
	char self[PATH_MAX];
	ssize_t n = readlink("/proc/self/exe", self, sizeof(self) - 1);
	if (n < 0)
		return 1;
	self[n] = '\0';
	char *root = dirname(self);

	char buf[PATH_MAX];
	/* Qt must stay off hybris EGL (single-display bug) and off the
	 * mirclient QPA the mir1 session presets */
	setenv("QT_QUICK_BACKEND", "software", 1);
	setenv("QT_WAYLAND_CLIENT_BUFFER_INTEGRATION", "none", 1);
	setenv("QT_QPA_PLATFORM", "wayland", 1);
	snprintf(buf, sizeof(buf), "%s/lib/qt5/plugins/platforms", root);
	setenv("QT_QPA_PLATFORM_PATH", buf, 1);
	snprintf(buf, sizeof(buf), "%s/lib/qt5/plugins", root);
	setenv("QT_PLUGIN_PATH", buf, 1);
	setenv("SDL_VIDEODRIVER", "wayland", 1);
	setenv("SDL_AUDIODRIVER", "pulseaudio", 1);
	setenv("HAS_DESKTOP_ENVIRONMENT", "0", 1);
	/* webkit's bwrap sandbox runs /usr/bin/xdg-dbus-proxy, which the
	 * image doesn't ship */
	setenv("WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS", "1", 1);
	snprintf(buf, sizeof(buf), "%s/lib", root);
	setenv("LD_LIBRARY_PATH", buf, 1);
	const char *preload = getenv("LD_PRELOAD");
	snprintf(buf, sizeof(buf), "%s%s%s/lib/webkit_zoom_hook.so:%s/lib/gtk_nocsd_hook.so",
			preload ? preload : "", preload ? ":" : "", root, root);
	setenv("LD_PRELOAD", buf, 1);

	/* confinement only allows the app-scoped XDG subdirs */
	const char *home = getenv("HOME");
	if (home) {
		scoped_xdg("XDG_CONFIG_HOME", home, ".config");
		scoped_xdg("XDG_CACHE_HOME", home, ".cache");
		scoped_xdg("XDG_DATA_HOME", home, ".local/share");
	}

	/* the session presets GTK_IM_MODULE=maliit, but the gtk module
	 * registers its context as Maliit */
	const char *cache = getenv("XDG_CACHE_HOME");
	if (cache) {
		snprintf(buf, sizeof(buf), "%s/immodules.cache", cache);
		FILE *f = fopen(buf, "w");
		if (f) {
			fprintf(f, "\"%s/lib/gtk-3.0/3.0.0/immodules/im-maliit.so\"\n"
					"\"Maliit\" \"Maliit Input Method\" \"maliit\" \"\" \"*\"\n",
					root);
			fclose(f);
			setenv("GTK_IM_MODULE_FILE", buf, 1);
			setenv("GTK_IM_MODULE", "Maliit", 1);
		}
	}

	pid_t pid = fork();
	if (pid == 0)
		hold_display_on();

	if (chdir(root))
		return 1;
	snprintf(buf, sizeof(buf), "%s/lib/volla_messages", root);
	argv[0] = buf;
	execv(buf, argv);
	return 1;
}
