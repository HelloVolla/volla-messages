/* Confined click launcher: the ubuntu-sdk template grants exec only inside
 * the app dir, so the shell wrapper is folded into this binary. */
#include <libgen.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>

static void scoped_xdg(const char *var, const char *home, const char *sub)
{
	char path[PATH_MAX];
	snprintf(path, sizeof(path), "%s/%s/volla-messages.volla", home, sub);
	mkdir(path, 0700);
	setenv(var, path, 1);
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

	/* webkit's bwrap sandbox runs /usr/bin/xdg-dbus-proxy, which the
	 * image doesn't ship */
	setenv("WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS", "1", 1);
	snprintf(buf, sizeof(buf), "%s/lib/" ARCH_TRIPLET, root);

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
			fprintf(f, "\"%s/lib/" ARCH_TRIPLET "/im-maliit.so\"\n"
					"\"Maliit\" \"Maliit Input Method\" \"maliit\" \"\" \"*\"\n",
					root);
			fclose(f);
			setenv("GTK_IM_MODULE_FILE", buf, 1);
			setenv("GTK_IM_MODULE", "Maliit", 1);
		}
	}

	if (chdir(root))
		return 1;

	snprintf(buf, sizeof(buf), "%s/volla_messages", root);
	argv[0] = buf;

	execv(buf, argv);
	return 1;
}
