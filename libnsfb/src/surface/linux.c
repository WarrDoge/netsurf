/*
 * Copyright 2012 Vincent Sanders <vince@simtec.co.uk>
 *
 * This file is part of libnsfb, http://www.netsurf-browser.org/
 * Licenced under the MIT License,
 *                http://www.opensource.org/licenses/mit-license.php
 *
 * Linux framebuffer (fbdev) surface with evdev input.
 */

#include <errno.h>
#include <fcntl.h>
#include <glob.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/types.h>

#include <linux/fb.h>
#include <linux/input.h>
#include <linux/kd.h>
#include <linux/vt.h>

#include "libnsfb.h"
#include "libnsfb_event.h"
#include "libnsfb_plot.h"
#include "libnsfb_plot_util.h"

#include "nsfb.h"
#include "plot.h"
#include "surface.h"
#include "cursor.h"

#define UNUSED(x) ((x) = (x))

#define DEFAULT_FB_DEVICE "/dev/fb0"
#define DEFAULT_INPUT_PATH "/dev/input"
#define DEFAULT_INPUT_GLOB "event*"

/** Maximum number of evdev devices polled at once. */
#define MAX_INPUT_DEVICES 32

/** Pending translated events between input() calls.
 *
 * One evdev read can yield a whole packet of events but the surface input
 * method hands back one at a time, so translated events queue here.
 */
#define EVENT_QUEUE_LEN 64

/** Wait this long, in milliseconds, when asked to wait forever but no input
 * device was opened. Without a cap the browser would never redraw again.
 */
#define NO_INPUT_POLL_MS 1000

#define BITS_PER_LONG (8 * (int)sizeof(long))
#define BIT_WORD(nr) ((nr) / BITS_PER_LONG)
#define BIT_MASK_LEN(nr) (((nr) + BITS_PER_LONG - 1) / BITS_PER_LONG)
#define TEST_BIT(bits, nr) \
	(((bits)[BIT_WORD(nr)] >> ((nr) % BITS_PER_LONG)) & 1)

struct lnx_input {
	int fd;
	bool grabbed;
	bool has_abs; /**< reports an absolute position, ie a touch device */
	struct input_absinfo abs_x;
	struct input_absinfo abs_y;
};

struct lnx_priv {
	int fd;
	struct fb_fix_screeninfo fix;
	struct fb_var_screeninfo var;

	struct fb_var_screeninfo saved_var; /**< mode to put back on exit */
	bool var_changed;

	uint8_t *vram; /**< mmapped video memory, distinct from nsfb->ptr */
	size_t vram_len;

	char *device;
	char *input_path;
	char *input_glob;

	int tty_fd;
	long saved_kd_mode;
	struct vt_mode saved_vt_mode;
	bool vt_owned;

	struct lnx_input input[MAX_INPUT_DEVICES];
	struct pollfd pfd[MAX_INPUT_DEVICES];
	int input_count;

	nsfb_event_t queue[EVENT_QUEUE_LEN];
	int queue_head;
	int queue_len;
};

/* VT switch signal handlers cannot be passed a context, and the kernel only
 * lets one process own a VT, so the handshake state is necessarily global.
 */
static volatile sig_atomic_t vt_release_requested;
static volatile sig_atomic_t vt_acquire_requested;

static void vt_release_handler(int sig)
{
	UNUSED(sig);
	vt_release_requested = 1;
}

static void vt_acquire_handler(int sig)
{
	UNUSED(sig);
	vt_acquire_requested = 1;
}

/* A killed process cannot restore the console from its own teardown, so the
 * owning surface is reachable from a signal handler. Without this a SIGTERM
 * leaves the VT in KD_GRAPHICS with VT_PROCESS set, which blanks that console
 * and hangs the next switch away from it.
 */
static struct lnx_priv *vt_owner;

static const int vt_fatal_signals[] = {
	SIGHUP, SIGINT, SIGQUIT, SIGILL, SIGABRT,
	SIGFPE, SIGBUS, SIGSEGV, SIGTERM
};

#define VT_FATAL_SIGNAL_COUNT \
	(int)(sizeof(vt_fatal_signals) / sizeof(vt_fatal_signals[0]))

static void vt_fatal_handler(int sig)
{
	struct sigaction sa;

	if (vt_owner != NULL) {
		ioctl(vt_owner->tty_fd, KDSETMODE, vt_owner->saved_kd_mode);
		ioctl(vt_owner->tty_fd, VT_SETMODE, &vt_owner->saved_vt_mode);
		vt_owner = NULL;
	}

	memset(&sa, 0, sizeof(sa));
	sa.sa_handler = SIG_DFL;
	sigaction(sig, &sa, NULL);
	raise(sig);
}

/** evdev code to libnsfb keycode.
 *
 * The NSFB_KEY_* values follow SDL 1.2 keysyms, which are the unshifted
 * symbol on a US layout. Shift and control are applied downstream by the
 * toolkit from the modifier key events, so no layout handling belongs here.
 */
static const uint16_t linux_key_map[KEY_MAX + 1] = {
	[KEY_ESC] = NSFB_KEY_ESCAPE,
	[KEY_1] = NSFB_KEY_1,
	[KEY_2] = NSFB_KEY_2,
	[KEY_3] = NSFB_KEY_3,
	[KEY_4] = NSFB_KEY_4,
	[KEY_5] = NSFB_KEY_5,
	[KEY_6] = NSFB_KEY_6,
	[KEY_7] = NSFB_KEY_7,
	[KEY_8] = NSFB_KEY_8,
	[KEY_9] = NSFB_KEY_9,
	[KEY_0] = NSFB_KEY_0,
	[KEY_MINUS] = NSFB_KEY_MINUS,
	[KEY_EQUAL] = NSFB_KEY_EQUALS,
	[KEY_BACKSPACE] = NSFB_KEY_BACKSPACE,
	[KEY_TAB] = NSFB_KEY_TAB,
	[KEY_Q] = NSFB_KEY_q,
	[KEY_W] = NSFB_KEY_w,
	[KEY_E] = NSFB_KEY_e,
	[KEY_R] = NSFB_KEY_r,
	[KEY_T] = NSFB_KEY_t,
	[KEY_Y] = NSFB_KEY_y,
	[KEY_U] = NSFB_KEY_u,
	[KEY_I] = NSFB_KEY_i,
	[KEY_O] = NSFB_KEY_o,
	[KEY_P] = NSFB_KEY_p,
	[KEY_LEFTBRACE] = NSFB_KEY_LEFTBRACKET,
	[KEY_RIGHTBRACE] = NSFB_KEY_RIGHTBRACKET,
	[KEY_ENTER] = NSFB_KEY_RETURN,
	[KEY_LEFTCTRL] = NSFB_KEY_LCTRL,
	[KEY_A] = NSFB_KEY_a,
	[KEY_S] = NSFB_KEY_s,
	[KEY_D] = NSFB_KEY_d,
	[KEY_F] = NSFB_KEY_f,
	[KEY_G] = NSFB_KEY_g,
	[KEY_H] = NSFB_KEY_h,
	[KEY_J] = NSFB_KEY_j,
	[KEY_K] = NSFB_KEY_k,
	[KEY_L] = NSFB_KEY_l,
	[KEY_SEMICOLON] = NSFB_KEY_SEMICOLON,
	[KEY_APOSTROPHE] = NSFB_KEY_QUOTE,
	[KEY_GRAVE] = NSFB_KEY_BACKQUOTE,
	[KEY_LEFTSHIFT] = NSFB_KEY_LSHIFT,
	[KEY_BACKSLASH] = NSFB_KEY_BACKSLASH,
	[KEY_Z] = NSFB_KEY_z,
	[KEY_X] = NSFB_KEY_x,
	[KEY_C] = NSFB_KEY_c,
	[KEY_V] = NSFB_KEY_v,
	[KEY_B] = NSFB_KEY_b,
	[KEY_N] = NSFB_KEY_n,
	[KEY_M] = NSFB_KEY_m,
	[KEY_COMMA] = NSFB_KEY_COMMA,
	[KEY_DOT] = NSFB_KEY_PERIOD,
	[KEY_SLASH] = NSFB_KEY_SLASH,
	[KEY_RIGHTSHIFT] = NSFB_KEY_RSHIFT,
	[KEY_KPASTERISK] = NSFB_KEY_KP_MULTIPLY,
	[KEY_LEFTALT] = NSFB_KEY_LALT,
	[KEY_SPACE] = NSFB_KEY_SPACE,
	[KEY_CAPSLOCK] = NSFB_KEY_CAPSLOCK,
	[KEY_F1] = NSFB_KEY_F1,
	[KEY_F2] = NSFB_KEY_F2,
	[KEY_F3] = NSFB_KEY_F3,
	[KEY_F4] = NSFB_KEY_F4,
	[KEY_F5] = NSFB_KEY_F5,
	[KEY_F6] = NSFB_KEY_F6,
	[KEY_F7] = NSFB_KEY_F7,
	[KEY_F8] = NSFB_KEY_F8,
	[KEY_F9] = NSFB_KEY_F9,
	[KEY_F10] = NSFB_KEY_F10,
	[KEY_NUMLOCK] = NSFB_KEY_NUMLOCK,
	[KEY_SCROLLLOCK] = NSFB_KEY_SCROLLOCK,
	[KEY_KP7] = NSFB_KEY_KP7,
	[KEY_KP8] = NSFB_KEY_KP8,
	[KEY_KP9] = NSFB_KEY_KP9,
	[KEY_KPMINUS] = NSFB_KEY_KP_MINUS,
	[KEY_KP4] = NSFB_KEY_KP4,
	[KEY_KP5] = NSFB_KEY_KP5,
	[KEY_KP6] = NSFB_KEY_KP6,
	[KEY_KPPLUS] = NSFB_KEY_KP_PLUS,
	[KEY_KP1] = NSFB_KEY_KP1,
	[KEY_KP2] = NSFB_KEY_KP2,
	[KEY_KP3] = NSFB_KEY_KP3,
	[KEY_KP0] = NSFB_KEY_KP0,
	[KEY_KPDOT] = NSFB_KEY_KP_PERIOD,
	[KEY_F11] = NSFB_KEY_F11,
	[KEY_F12] = NSFB_KEY_F12,
	[KEY_KPENTER] = NSFB_KEY_KP_ENTER,
	[KEY_RIGHTCTRL] = NSFB_KEY_RCTRL,
	[KEY_KPSLASH] = NSFB_KEY_KP_DIVIDE,
	[KEY_SYSRQ] = NSFB_KEY_SYSREQ,
	[KEY_RIGHTALT] = NSFB_KEY_RALT,
	[KEY_HOME] = NSFB_KEY_HOME,
	[KEY_UP] = NSFB_KEY_UP,
	[KEY_PAGEUP] = NSFB_KEY_PAGEUP,
	[KEY_LEFT] = NSFB_KEY_LEFT,
	[KEY_RIGHT] = NSFB_KEY_RIGHT,
	[KEY_END] = NSFB_KEY_END,
	[KEY_DOWN] = NSFB_KEY_DOWN,
	[KEY_PAGEDOWN] = NSFB_KEY_PAGEDOWN,
	[KEY_INSERT] = NSFB_KEY_INSERT,
	[KEY_DELETE] = NSFB_KEY_DELETE,
	[KEY_KPEQUAL] = NSFB_KEY_KP_EQUALS,
	[KEY_PAUSE] = NSFB_KEY_PAUSE,
	[KEY_LEFTMETA] = NSFB_KEY_LMETA,
	[KEY_RIGHTMETA] = NSFB_KEY_RMETA,
	[KEY_COMPOSE] = NSFB_KEY_MENU,
	[KEY_F13] = NSFB_KEY_F13,
	[KEY_F14] = NSFB_KEY_F14,
	[KEY_F15] = NSFB_KEY_F15,
	[KEY_HELP] = NSFB_KEY_HELP,
	[KEY_MENU] = NSFB_KEY_MENU,
	[KEY_UNDO] = NSFB_KEY_UNDO,
	[KEY_PRINT] = NSFB_KEY_PRINT,
	[KEY_POWER] = NSFB_KEY_POWER,
};


/**
 * Derive the libnsfb pixel format from the framebuffer bitfield layout.
 *
 * The libnsfb format names read the pixel word most significant component
 * first, which is the opposite direction to the fb_bitfield offsets, so
 * XRGB8888 is red at offset 16 and blue at offset 0.
 */
static bool
format_from_var(const struct fb_var_screeninfo *var, enum nsfb_format_e *fmt)
{
	bool alpha = (var->transp.length > 0);

	switch (var->bits_per_pixel) {
	case 32:
		if ((var->red.offset == 16) &&
		    (var->green.offset == 8) &&
		    (var->blue.offset == 0)) {
			*fmt = alpha ? NSFB_FMT_ARGB8888 : NSFB_FMT_XRGB8888;
			return true;
		}
		if ((var->red.offset == 0) &&
		    (var->green.offset == 8) &&
		    (var->blue.offset == 16)) {
			*fmt = alpha ? NSFB_FMT_ABGR8888 : NSFB_FMT_XBGR8888;
			return true;
		}
		return false;

	case 16:
		if ((var->green.length == 6) &&
		    (var->red.offset == 11) &&
		    (var->green.offset == 5) &&
		    (var->blue.offset == 0)) {
			*fmt = NSFB_FMT_RGB565;
			return true;
		}
		if ((var->green.length == 5) &&
		    (var->red.offset == 10) &&
		    (var->green.offset == 5) &&
		    (var->blue.offset == 0)) {
			*fmt = NSFB_FMT_ARGB1555;
			return true;
		}
		return false;
	}

	return false;
}


/**
 * Copy a damaged region of the back buffer into video memory.
 *
 * Plotting straight into the mmapped region is slow on write and far worse
 * on the read half of every read-modify-write, because it is usually
 * write-combining uncached memory. It also tears while scrolling. So the
 * plotters work on an ordinary heap buffer and only the damage lands here.
 */
static void linux_blit(nsfb_t *nsfb, const nsfb_bbox_t *box)
{
	struct lnx_priv *lstate = nsfb->surface_priv;
	nsfb_bbox_t area;
	int bytes_pp;
	size_t row_bytes;
	const uint8_t *src;
	uint8_t *dst;
	int y;

	if ((lstate == NULL) || (lstate->vram == NULL)) {
		return;
	}

	bytes_pp = nsfb->bpp / 8;

	area = *box;
	if (area.x0 < 0) {
		area.x0 = 0;
	}
	if (area.y0 < 0) {
		area.y0 = 0;
	}
	if (area.x1 > nsfb->width) {
		area.x1 = nsfb->width;
	}
	if (area.y1 > nsfb->height) {
		area.y1 = nsfb->height;
	}
	if ((area.x0 >= area.x1) || (area.y0 >= area.y1)) {
		return;
	}

	row_bytes = (size_t)(area.x1 - area.x0) * bytes_pp;

	src = nsfb->ptr +
		((size_t)area.y0 * nsfb->linelen) +
		((size_t)area.x0 * bytes_pp);

	dst = lstate->vram +
		((size_t)(area.y0 + lstate->var.yoffset) * lstate->fix.line_length) +
		((size_t)(area.x0 + lstate->var.xoffset) * bytes_pp);

	for (y = area.y0; y < area.y1; y++) {
		memcpy(dst, src, row_bytes);
		src += nsfb->linelen;
		dst += lstate->fix.line_length;
	}
}


static void linux_blit_all(nsfb_t *nsfb)
{
	nsfb_bbox_t all;

	all.x0 = 0;
	all.y0 = 0;
	all.x1 = nsfb->width;
	all.y1 = nsfb->height;

	linux_blit(nsfb, &all);
}


/**
 * Take over the console this process is attached to.
 *
 * Without this the kernel text console keeps drawing over the page. Failure
 * is not fatal: it just means the framebuffer is not a console we own, which
 * is the normal case when testing from a terminal emulator.
 */
static void linux_vt_claim(struct lnx_priv *lstate)
{
	struct vt_stat vtstat;
	struct vt_mode vtmode;
	struct sigaction sa;
	int i;

	lstate->tty_fd = open("/dev/tty", O_RDWR | O_CLOEXEC);
	if (lstate->tty_fd < 0) {
		return;
	}

	/* only a real virtual terminal answers this */
	if (ioctl(lstate->tty_fd, VT_GETSTATE, &vtstat) < 0) {
		close(lstate->tty_fd);
		lstate->tty_fd = -1;
		return;
	}

	if (ioctl(lstate->tty_fd, KDGETMODE, &lstate->saved_kd_mode) < 0) {
		lstate->saved_kd_mode = KD_TEXT;
	}

	if (ioctl(lstate->tty_fd, VT_GETMODE, &lstate->saved_vt_mode) < 0) {
		close(lstate->tty_fd);
		lstate->tty_fd = -1;
		return;
	}

	memset(&sa, 0, sizeof(sa));
	sa.sa_handler = vt_release_handler;
	sigaction(SIGUSR1, &sa, NULL);
	sa.sa_handler = vt_acquire_handler;
	sigaction(SIGUSR2, &sa, NULL);

	vtmode = lstate->saved_vt_mode;
	vtmode.mode = VT_PROCESS;
	vtmode.waitv = 0;
	vtmode.relsig = SIGUSR1;
	vtmode.acqsig = SIGUSR2;

	if (ioctl(lstate->tty_fd, VT_SETMODE, &vtmode) < 0) {
		close(lstate->tty_fd);
		lstate->tty_fd = -1;
		return;
	}

	if (ioctl(lstate->tty_fd, KDSETMODE, KD_GRAPHICS) < 0) {
		ioctl(lstate->tty_fd, VT_SETMODE, &lstate->saved_vt_mode);
		close(lstate->tty_fd);
		lstate->tty_fd = -1;
		return;
	}

	vt_owner = lstate;
	sa.sa_handler = vt_fatal_handler;
	for (i = 0; i < VT_FATAL_SIGNAL_COUNT; i++) {
		struct sigaction old;

		/* respect a disposition the caller deliberately set */
		if ((sigaction(vt_fatal_signals[i], NULL, &old) == 0) &&
		    (old.sa_handler == SIG_IGN)) {
			continue;
		}
		sigaction(vt_fatal_signals[i], &sa, NULL);
	}

	lstate->vt_owned = true;
}


static void linux_vt_release(struct lnx_priv *lstate)
{
	struct sigaction sa;
	int i;

	if (lstate->tty_fd < 0) {
		return;
	}

	if (lstate->vt_owned) {
		ioctl(lstate->tty_fd, KDSETMODE, lstate->saved_kd_mode);
		ioctl(lstate->tty_fd, VT_SETMODE, &lstate->saved_vt_mode);

		memset(&sa, 0, sizeof(sa));
		sa.sa_handler = SIG_DFL;
		sigaction(SIGUSR1, &sa, NULL);
		sigaction(SIGUSR2, &sa, NULL);
		for (i = 0; i < VT_FATAL_SIGNAL_COUNT; i++) {
			sigaction(vt_fatal_signals[i], &sa, NULL);
		}

		vt_owner = NULL;
		lstate->vt_owned = false;
	}

	close(lstate->tty_fd);
	lstate->tty_fd = -1;
}


/**
 * Complete a pending VT switch handshake.
 *
 * The kernel will not switch away until VT_RELDISP is acknowledged, and on
 * the way back the console we left behind has scribbled over video memory,
 * so the whole back buffer has to be pushed out again.
 */
static void linux_vt_poll(nsfb_t *nsfb)
{
	struct lnx_priv *lstate = nsfb->surface_priv;

	if (lstate->vt_owned == false) {
		return;
	}

	if (vt_release_requested) {
		vt_release_requested = 0;
		ioctl(lstate->tty_fd, KDSETMODE, KD_TEXT);
		ioctl(lstate->tty_fd, VT_RELDISP, 1);
	}

	if (vt_acquire_requested) {
		vt_acquire_requested = 0;
		ioctl(lstate->tty_fd, VT_RELDISP, VT_ACKACQ);
		ioctl(lstate->tty_fd, KDSETMODE, KD_GRAPHICS);
		linux_blit_all(nsfb);
	}
}


/**
 * Add one evdev device to the poll set if it can produce anything we use.
 */
static void linux_input_add(struct lnx_priv *lstate, const char *path)
{
	unsigned long evbits[BIT_MASK_LEN(EV_MAX + 1)];
	struct lnx_input *in;
	int fd;

	if (lstate->input_count >= MAX_INPUT_DEVICES) {
		return;
	}

	fd = open(path, O_RDONLY | O_NONBLOCK | O_CLOEXEC);
	if (fd < 0) {
		return;
	}

	memset(evbits, 0, sizeof(evbits));
	if (ioctl(fd, EVIOCGBIT(0, sizeof(evbits)), evbits) < 0) {
		close(fd);
		return;
	}

	if (!TEST_BIT(evbits, EV_KEY) &&
	    !TEST_BIT(evbits, EV_REL) &&
	    !TEST_BIT(evbits, EV_ABS)) {
		/* a lid switch, a power button, an accelerometer */
		close(fd);
		return;
	}

	in = &lstate->input[lstate->input_count];
	memset(in, 0, sizeof(*in));
	in->fd = fd;

	if (TEST_BIT(evbits, EV_ABS) &&
	    (ioctl(fd, EVIOCGABS(ABS_X), &in->abs_x) >= 0) &&
	    (ioctl(fd, EVIOCGABS(ABS_Y), &in->abs_y) >= 0) &&
	    (in->abs_x.maximum > in->abs_x.minimum) &&
	    (in->abs_y.maximum > in->abs_y.minimum)) {
		in->has_abs = true;
	}

	/* Grabbing stops keystrokes reaching the shell behind the browser,
	 * but only do it when we own the console. Grabbing the keyboard out
	 * from under a running display server would be hostile.
	 */
	if (lstate->vt_owned && (ioctl(fd, EVIOCGRAB, 1) >= 0)) {
		in->grabbed = true;
	}

	lstate->pfd[lstate->input_count].fd = fd;
	lstate->pfd[lstate->input_count].events = POLLIN;
	lstate->pfd[lstate->input_count].revents = 0;

	lstate->input_count++;
}


static void linux_input_open(struct lnx_priv *lstate)
{
	const char *dir = lstate->input_path ?
		lstate->input_path : DEFAULT_INPUT_PATH;
	const char *pattern = lstate->input_glob ?
		lstate->input_glob : DEFAULT_INPUT_GLOB;
	char *spec;
	size_t spec_len;
	struct stat sb;
	glob_t gl;
	size_t i;

	/* a path naming a device node is used on its own */
	if ((stat(dir, &sb) == 0) && !S_ISDIR(sb.st_mode)) {
		linux_input_add(lstate, dir);
		return;
	}

	spec_len = strlen(dir) + strlen(pattern) + 2;
	spec = malloc(spec_len);
	if (spec == NULL) {
		return;
	}
	snprintf(spec, spec_len, "%s/%s", dir, pattern);

	memset(&gl, 0, sizeof(gl));
	if (glob(spec, 0, NULL, &gl) == 0) {
		for (i = 0; i < gl.gl_pathc; i++) {
			linux_input_add(lstate, gl.gl_pathv[i]);
		}
	}
	globfree(&gl);

	free(spec);
}


static void linux_input_close(struct lnx_priv *lstate)
{
	int i;

	for (i = 0; i < lstate->input_count; i++) {
		if (lstate->input[i].grabbed) {
			ioctl(lstate->input[i].fd, EVIOCGRAB, 0);
		}
		close(lstate->input[i].fd);
	}

	lstate->input_count = 0;
}


static void linux_queue_push(struct lnx_priv *lstate, const nsfb_event_t *event)
{
	int slot;

	if (lstate->queue_len >= EVENT_QUEUE_LEN) {
		return; /* input burst longer than the queue; drop the tail */
	}

	slot = (lstate->queue_head + lstate->queue_len) % EVENT_QUEUE_LEN;
	lstate->queue[slot] = *event;
	lstate->queue_len++;
}


static bool linux_queue_pop(struct lnx_priv *lstate, nsfb_event_t *event)
{
	if (lstate->queue_len == 0) {
		return false;
	}

	*event = lstate->queue[lstate->queue_head];
	lstate->queue_head = (lstate->queue_head + 1) % EVENT_QUEUE_LEN;
	lstate->queue_len--;

	return true;
}


static void
linux_queue_key(struct lnx_priv *lstate, enum nsfb_key_code_e code, bool down)
{
	nsfb_event_t event;

	event.type = down ? NSFB_EVENT_KEY_DOWN : NSFB_EVENT_KEY_UP;
	event.value.keycode = code;

	linux_queue_push(lstate, &event);
}


static int linux_scale_abs(int value, const struct input_absinfo *abs, int extent)
{
	int range = abs->maximum - abs->minimum;

	if (range <= 0) {
		return 0;
	}

	if (value < abs->minimum) {
		value = abs->minimum;
	}
	if (value > abs->maximum) {
		value = abs->maximum;
	}

	return (int)(((int64_t)(value - abs->minimum) * (extent - 1)) / range);
}


/**
 * Drain one evdev device and translate its packet into queued events.
 *
 * Relative motion is accumulated across the packet and emitted once at
 * SYN_REPORT, because a single mouse movement arrives as separate REL_X and
 * REL_Y events and there is no point warping the pointer twice.
 */
static void
linux_input_read(nsfb_t *nsfb, struct lnx_priv *lstate, struct lnx_input *in)
{
	struct input_event ev[32];
	nsfb_event_t event;
	ssize_t got;
	size_t count;
	size_t i;
	int rel_x = 0;
	int rel_y = 0;
	int abs_x = -1;
	int abs_y = -1;
	bool have_rel = false;
	bool have_abs = false;

	while (true) {
		got = read(in->fd, ev, sizeof(ev));
		if (got <= 0) {
			break;
		}

		count = (size_t)got / sizeof(ev[0]);

		for (i = 0; i < count; i++) {
			switch (ev[i].type) {
			case EV_KEY:
				switch (ev[i].code) {
				case BTN_LEFT:
				case BTN_TOUCH:
					linux_queue_key(lstate, NSFB_KEY_MOUSE_1,
							ev[i].value != 0);
					break;

				case BTN_MIDDLE:
					linux_queue_key(lstate, NSFB_KEY_MOUSE_2,
							ev[i].value != 0);
					break;

				case BTN_RIGHT:
					linux_queue_key(lstate, NSFB_KEY_MOUSE_3,
							ev[i].value != 0);
					break;

				default:
					/* value 2 is autorepeat, which the
					 * toolkit wants as another key down
					 */
					if (ev[i].code <= KEY_MAX &&
					    linux_key_map[ev[i].code] != NSFB_KEY_UNKNOWN) {
						linux_queue_key(lstate,
							linux_key_map[ev[i].code],
							ev[i].value != 0);
					}
					break;
				}
				break;

			case EV_REL:
				switch (ev[i].code) {
				case REL_X:
					rel_x += ev[i].value;
					have_rel = true;
					break;

				case REL_Y:
					rel_y += ev[i].value;
					have_rel = true;
					break;

				case REL_WHEEL:
					/* the toolkit scrolls on the press and
					 * ignores the release, but send both so
					 * no button is left latched down
					 */
					if (ev[i].value > 0) {
						linux_queue_key(lstate, NSFB_KEY_MOUSE_4, true);
						linux_queue_key(lstate, NSFB_KEY_MOUSE_4, false);
					} else if (ev[i].value < 0) {
						linux_queue_key(lstate, NSFB_KEY_MOUSE_5, true);
						linux_queue_key(lstate, NSFB_KEY_MOUSE_5, false);
					}
					break;

				default:
					break;
				}
				break;

			case EV_ABS:
				if (in->has_abs == false) {
					break;
				}
				if (ev[i].code == ABS_X) {
					abs_x = linux_scale_abs(ev[i].value,
								&in->abs_x,
								nsfb->width);
					have_abs = true;
				} else if (ev[i].code == ABS_Y) {
					abs_y = linux_scale_abs(ev[i].value,
								&in->abs_y,
								nsfb->height);
					have_abs = true;
				}
				break;

			case EV_SYN:
				if (ev[i].code != SYN_REPORT) {
					break;
				}

				if (have_abs && (abs_x >= 0) && (abs_y >= 0)) {
					event.type = NSFB_EVENT_MOVE_ABSOLUTE;
					event.value.vector.x = abs_x;
					event.value.vector.y = abs_y;
					event.value.vector.z = 0;
					linux_queue_push(lstate, &event);
				} else if (have_rel && ((rel_x != 0) || (rel_y != 0))) {
					event.type = NSFB_EVENT_MOVE_RELATIVE;
					event.value.vector.x = rel_x;
					event.value.vector.y = rel_y;
					event.value.vector.z = 0;
					linux_queue_push(lstate, &event);
				}

				rel_x = 0;
				rel_y = 0;
				have_rel = false;
				have_abs = false;
				break;

			default:
				break;
			}
		}
	}
}


static int
linux_set_geometry(nsfb_t *nsfb, int width, int height, enum nsfb_format_e format)
{
	struct lnx_priv *lstate = nsfb->surface_priv;

	if ((lstate != NULL) && (lstate->fd >= 0)) {
		return -1; /* the mode is fixed once the device is open */
	}

	nsfb->width = width;
	nsfb->height = height;
	nsfb->format = format;

	if (select_plotters(nsfb) != true) {
		return -1;
	}

	return 0;
}


/**
 * Ask the driver for the requested mode, best effort.
 *
 * Most modern kernel drivers expose a fixed mode through the fbdev
 * compatibility layer and quietly refuse or clamp anything else, so whatever
 * comes back from the reread is what we actually use.
 */
static void linux_try_mode(struct lnx_priv *lstate, int width, int height, int bpp)
{
	struct fb_var_screeninfo want = lstate->var;
	uint32_t saved_line_length;

	if ((width > 0) && (height > 0)) {
		want.xres = width;
		want.yres = height;
		if (want.xres_virtual < want.xres) {
			want.xres_virtual = want.xres;
		}
		if (want.yres_virtual < want.yres) {
			want.yres_virtual = want.yres;
		}
	}

	if (bpp > 0) {
		want.bits_per_pixel = bpp;
	}

	if (memcmp(&want, &lstate->var, sizeof(want)) == 0) {
		return;
	}

	want.activate = FB_ACTIVATE_NOW;

	saved_line_length = lstate->fix.line_length;

	if (ioctl(lstate->fd, FBIOPUT_VSCREENINFO, &want) < 0) {
		return;
	}

	lstate->var_changed = true;

	/* re-read rather than trusting what we asked for; the driver is
	 * entitled to have given us something else
	 */
	ioctl(lstate->fd, FBIOGET_VSCREENINFO, &lstate->var);
	ioctl(lstate->fd, FBIOGET_FSCREENINFO, &lstate->fix);

	/* DRM's fbdev emulation accepts a smaller mode by shrinking the
	 * visible region without reprogramming the CRTC. The stride stays at
	 * the panel's, so the page lands in a corner of an otherwise dead
	 * screen. A real mode change moves the stride with it; when it has not
	 * moved, take the panel's own mode instead.
	 */
	if (((lstate->var.xres < lstate->saved_var.xres) ||
	     (lstate->var.yres < lstate->saved_var.yres)) &&
	    (lstate->fix.line_length == saved_line_length)) {
		ioctl(lstate->fd, FBIOPUT_VSCREENINFO, &lstate->saved_var);
		ioctl(lstate->fd, FBIOGET_VSCREENINFO, &lstate->var);
		ioctl(lstate->fd, FBIOGET_FSCREENINFO, &lstate->fix);
		lstate->var_changed = false;
	}
}


static int linux_initialise(nsfb_t *nsfb)
{
	struct lnx_priv *lstate;
	enum nsfb_format_e lformat;
	const char *device;
	uint8_t *backbuf;
	size_t backbuf_len;
	int req_width;
	int req_height;
	int req_bpp;

	lstate = nsfb->surface_priv;

	if ((lstate != NULL) && (lstate->fd >= 0)) {
		return -1; /* already initialised */
	}

	/* linux_parameters may already have allocated the state */
	if (lstate == NULL) {
		lstate = calloc(1, sizeof(*lstate));
		if (lstate == NULL) {
			return -1;
		}
		lstate->fd = -1;
		lstate->tty_fd = -1;
	}

	req_width = nsfb->width;
	req_height = nsfb->height;
	req_bpp = nsfb->bpp;

	device = lstate->device ? lstate->device : DEFAULT_FB_DEVICE;

	lstate->fd = open(device, O_RDWR | O_CLOEXEC);
	if (lstate->fd < 0) {
		fprintf(stderr, "unable to open framebuffer %s: %s\n",
			device, strerror(errno));
		goto fail_state;
	}

	if (ioctl(lstate->fd, FBIOGET_FSCREENINFO, &lstate->fix) < 0) {
		fprintf(stderr, "unable to read fixed screen info: %s\n",
			strerror(errno));
		goto fail_fd;
	}

	if (ioctl(lstate->fd, FBIOGET_VSCREENINFO, &lstate->var) < 0) {
		fprintf(stderr, "unable to read variable screen info: %s\n",
			strerror(errno));
		goto fail_fd;
	}

	lstate->saved_var = lstate->var;

	linux_try_mode(lstate, req_width, req_height, req_bpp);

	if (format_from_var(&lstate->var, &lformat) == false) {
		fprintf(stderr,
			"%s is %ubpp with red at bit %u, green at %u and blue "
			"at %u, which libnsfb has no plotters for; "
			"try fb_depth 16 or 32\n",
			device,
			lstate->var.bits_per_pixel,
			lstate->var.red.offset,
			lstate->var.green.offset,
			lstate->var.blue.offset);
		goto fail_mode;
	}

	nsfb->width = lstate->var.xres;
	nsfb->height = lstate->var.yres;
	nsfb->format = lformat;

	if (select_plotters(nsfb) != true) {
		fprintf(stderr, "no plotters available for the selected format\n");
		goto fail_mode;
	}

	lstate->vram_len = lstate->fix.smem_len;
	if (lstate->vram_len == 0) {
		lstate->vram_len = (size_t)lstate->fix.line_length *
			lstate->var.yres_virtual;
	}

	lstate->vram = mmap(NULL, lstate->vram_len, PROT_READ | PROT_WRITE,
			    MAP_SHARED, lstate->fd, 0);
	if (lstate->vram == MAP_FAILED) {
		fprintf(stderr, "unable to map %zu bytes of %s: %s\n",
			lstate->vram_len, device, strerror(errno));
		lstate->vram = NULL;
		goto fail_mode;
	}

	nsfb->linelen = (nsfb->width * nsfb->bpp) / 8;
	backbuf_len = (size_t)nsfb->linelen * nsfb->height;

	backbuf = calloc(1, backbuf_len);
	if (backbuf == NULL) {
		goto fail_mmap;
	}
	nsfb->ptr = backbuf;

	nsfb->surface_priv = lstate;

	linux_vt_claim(lstate);
	linux_input_open(lstate);

	linux_blit_all(nsfb);

	return 0;

fail_mmap:
	munmap(lstate->vram, lstate->vram_len);
	lstate->vram = NULL;
fail_mode:
	if (lstate->var_changed) {
		ioctl(lstate->fd, FBIOPUT_VSCREENINFO, &lstate->saved_var);
	}
fail_fd:
	close(lstate->fd);
	lstate->fd = -1;
fail_state:
	free(lstate->device);
	free(lstate->input_path);
	free(lstate->input_glob);
	free(lstate);

	nsfb->surface_priv = NULL;

	return -1;
}


static int linux_finalise(nsfb_t *nsfb)
{
	struct lnx_priv *lstate = nsfb->surface_priv;

	if (lstate == NULL) {
		return 0;
	}

	linux_input_close(lstate);
	linux_vt_release(lstate);

	if (lstate->vram != NULL) {
		munmap(lstate->vram, lstate->vram_len);
		lstate->vram = NULL;
	}

	if (lstate->fd >= 0) {
		if (lstate->var_changed) {
			lstate->saved_var.activate = FB_ACTIVATE_NOW;
			ioctl(lstate->fd, FBIOPUT_VSCREENINFO, &lstate->saved_var);
		}
		close(lstate->fd);
		lstate->fd = -1;
	}

	free(nsfb->ptr);
	nsfb->ptr = NULL;

	free(lstate->device);
	free(lstate->input_path);
	free(lstate->input_glob);
	free(lstate);

	nsfb->surface_priv = NULL;

	return 0;
}


/**
 * Accept "device=", "input=" and "inputglob=" in a comma separated list.
 *
 * This is how the frontend passes its fb_device, fb_input_devpath and
 * fb_input_glob options down, since libnsfb has no access to the option
 * table itself.
 */
static int linux_parameters(nsfb_t *nsfb, const char *parameters)
{
	struct lnx_priv *lstate = nsfb->surface_priv;
	const char *cur = parameters;

	if (lstate != NULL) {
		return -1; /* too late, the device is already open */
	}

	lstate = calloc(1, sizeof(*lstate));
	if (lstate == NULL) {
		return -1;
	}
	lstate->fd = -1;
	lstate->tty_fd = -1;

	while (*cur != '\0') {
		const char *end = strchr(cur, ',');
		const char *eq = strchr(cur, '=');
		size_t value_len;
		char **target = NULL;

		if (end == NULL) {
			end = cur + strlen(cur);
		}

		if ((eq == NULL) || (eq > end)) {
			goto next;
		}

		if (strncmp(cur, "device=", 7) == 0) {
			target = &lstate->device;
		} else if (strncmp(cur, "input=", 6) == 0) {
			target = &lstate->input_path;
		} else if (strncmp(cur, "inputglob=", 10) == 0) {
			target = &lstate->input_glob;
		}

		if (target != NULL) {
			value_len = (size_t)(end - eq - 1);
			free(*target);
			*target = malloc(value_len + 1);
			if (*target != NULL) {
				memcpy(*target, eq + 1, value_len);
				(*target)[value_len] = '\0';
			}
		}

	next:
		cur = (*end == '\0') ? end : end + 1;
	}

	nsfb->surface_priv = lstate;

	return 0;
}


static int linux_claim(nsfb_t *nsfb, nsfb_bbox_t *box)
{
	struct nsfb_cursor_s *cursor = nsfb->cursor;

	if ((cursor != NULL) &&
	    (cursor->plotted == true) &&
	    (nsfb_plot_bbox_intersect(box, &cursor->loc))) {
		nsfb_cursor_clear(nsfb, cursor);
	}

	return 0;
}


static int linux_update(nsfb_t *nsfb, nsfb_bbox_t *box)
{
	struct nsfb_cursor_s *cursor = nsfb->cursor;

	if ((cursor != NULL) && (cursor->plotted == false)) {
		nsfb_cursor_plot(nsfb, cursor);
	}

	linux_blit(nsfb, box);

	return 0;
}


static int linux_cursor(nsfb_t *nsfb, struct nsfb_cursor_s *cursor)
{
	nsfb_bbox_t loc_shift;
	nsfb_bbox_t redraw;
	nsfb_bbox_t fbarea;

	if ((cursor == NULL) || (cursor->plotted == false)) {
		return true;
	}

	loc_shift = cursor->loc;
	loc_shift.x0 -= cursor->hotspot_x;
	loc_shift.y0 -= cursor->hotspot_y;
	loc_shift.x1 -= cursor->hotspot_x;
	loc_shift.y1 -= cursor->hotspot_y;

	nsfb_plot_add_rect(&cursor->savloc, &loc_shift, &redraw);

	fbarea.x0 = 0;
	fbarea.y0 = 0;
	fbarea.x1 = nsfb->width;
	fbarea.y1 = nsfb->height;

	nsfb_plot_clip(&fbarea, &redraw);

	nsfb_cursor_clear(nsfb, cursor);
	nsfb_cursor_plot(nsfb, cursor);

	linux_blit(nsfb, &redraw);

	return true;
}


static bool linux_input(nsfb_t *nsfb, nsfb_event_t *event, int timeout)
{
	struct lnx_priv *lstate = nsfb->surface_priv;
	int ready;
	int i;

	if (lstate == NULL) {
		return false;
	}

	linux_vt_poll(nsfb);

	if (linux_queue_pop(lstate, event)) {
		return true;
	}

	if ((lstate->input_count == 0) && (timeout < 0)) {
		/* nothing can ever wake us, but the caller still has a
		 * scheduler and a screen to redraw
		 */
		timeout = NO_INPUT_POLL_MS;
	}

	ready = poll(lstate->pfd, (nfds_t)lstate->input_count, timeout);
	if (ready <= 0) {
		/* a VT switch signal interrupts the wait; picked up on the
		 * next call
		 */
		return false;
	}

	for (i = 0; i < lstate->input_count; i++) {
		if (lstate->pfd[i].revents & POLLIN) {
			linux_input_read(nsfb, lstate, &lstate->input[i]);
		}
	}

	return linux_queue_pop(lstate, event);
}


const nsfb_surface_rtns_t linux_rtns = {
	.initialise = linux_initialise,
	.finalise = linux_finalise,
	.input = linux_input,
	.claim = linux_claim,
	.update = linux_update,
	.cursor = linux_cursor,
	.geometry = linux_set_geometry,
	.parameters = linux_parameters,
};

NSFB_SURFACE_DEF(linux, NSFB_SURFACE_LINUX, &linux_rtns)

/*
 * Local variables:
 *  c-basic-offset: 8
 *  tab-width: 8
 * End:
 */
