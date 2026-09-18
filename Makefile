#!/bin/make
#
# NetSurf Source makefile for libraries and browser
#
# This tree is pruned to the framebuffer target only.
#
# The TARGET variable changes what toolkit is built for valid values are:
#  framebuffer (default if unset)
#  monkey (headless test driver)
#
# The HOST variable controls the targetted ABI. The default is to use the
#  BUILD variable contents which in turn defaults to the current cc default
#  ABI target

# Component settings
COMPONENT := netsurf-all
COMPONENT_VERSION := 3.11

# Targets

# Netsurf target
NETSURF_TARG := netsurf

# nsgenbind host tool
NSGENBIND_TARG := nsgenbind

# Library targets
NSLIB_ALL_TARG := buildsystem libnslog libwapcaplet libparserutils libcss libhubbub libdom libnsbmp libnsgif libnsutils libutf8proc libnspsl

NSLIB_SVGTINY_TARG := libsvgtiny

NSLIB_FB_TARG := libnsfb


# Build Environment
export TARGET ?= framebuffer
TMP_PREFIX := $(CURDIR)/inst-$(TARGET)
export PKG_CONFIG_PATH := $(TMP_PREFIX)/lib/pkgconfig:$(PKG_CONFIG_PATH)
export PATH := $(PATH):$(TMP_PREFIX)/bin/
TMP_NSSHARED := $(CURDIR)/buildsystem

# The system actually doing the build
BUILD ?= $(shell $(CC) -dumpmachine)
# The host we are targetting
HOST ?= $(BUILD)

# build verbosity. 
# NetSurf uses the kernel style quiet Q variable but we also need to cope with thr GNU V=1 style
ifeq ($(V),1)
  Q:=
else
  Q=@
endif


# only build what we require for the target
NSLIB_TARG := $(NSLIB_ALL_TARG) $(NSLIB_SVGTINY_TARG) $(NSLIB_FB_TARG)
NSBUILD_TARG := $(NSGENBIND_TARG)

.PHONY: build install clean checkout-release checkout-head dist dist-head

# clean macro for each sub target
define do_clean
	$(MAKE) distclean --directory=$1 HOST=$(HOST) NSSHARED=$(TMP_NSSHARED) Q=$(Q)

endef

# clean macro for each host sub target
define do_build_clean
	$(MAKE) distclean --directory=$1 HOST=$(HOST) NSSHARED=$(TMP_NSSHARED) Q=$(Q)

endef

# prefixed install macro for each sub target
define do_prefix_install
	$(MAKE) install --directory=$1 HOST=$(HOST) PREFIX=$(TMP_PREFIX) Q=$(Q) WARNFLAGS='-Wall -W -Wno-error' DESTDIR=

endef

# prefixed install macro for each host sub target
define do_build_prefix_install
	$(MAKE) install --directory=$1 HOST=$(BUILD) PREFIX=$(TMP_PREFIX) Q=$(Q) DESTDIR=

endef

build: $(TMP_PREFIX)/build-stamp

$(TMP_PREFIX)/build-stamp:
	mkdir -p $(TMP_PREFIX)/include
	mkdir -p $(TMP_PREFIX)/lib
	mkdir -p $(TMP_PREFIX)/bin
	$(foreach L,$(NSLIB_TARG),$(call do_prefix_install,$(L)))
	$(foreach L,$(NSBUILD_TARG),$(call do_build_prefix_install,$(L)))
	$(MAKE) --directory=$(NETSURF_TARG) PREFIX=$(PREFIX) TARGET=$(TARGET) $(NETSURF_CONFIG)
	touch $@

package: $(TMP_PREFIX)/build-stamp
	$(MAKE) --directory=$(NETSURF_TARG) PREFIX=$(PREFIX) TARGET=$(TARGET) package $(NETSURF_CONFIG)

install: $(TMP_PREFIX)/build-stamp
	$(MAKE) install --directory=$(NETSURF_TARG) TARGET=$(TARGET) PREFIX=$(PREFIX) DESTDIR=$(DESTDIR) $(NETSURF_CONFIG)

clean:
	$(RM) -r $(TMP_PREFIX)
	$(foreach L,$(NSLIB_TARG),$(call do_clean,$(L)))
	$(foreach L,$(NSBUILD_TARG),$(call do_build_clean,$(L)))
	$(MAKE) clean --directory=$(NETSURF_TARG) TARGET=$(TARGET)

# check out last release tag on each submodule
checkout-release: $(NSLIB_TARG) $(NETSURF_TARG) $(NSGENBIND_TARG)
	git fetch --recurse-submodules
	for x in $^; do cd $$x; (git checkout origin/HEAD && git checkout $$(git describe --abbrev=0 --match="release/*" )); cd ..; done

# check out head on each submodule
checkout-head: $(NSLIB_TARG) $(NETSURF_TARG) $(NSGENBIND_TARG)
	git submodule init
	git submodule update
	git fetch --recurse-submodules
	for x in $^; do cd $$x; git checkout origin/HEAD ; cd ..; done

# Generate a dist tarball from the head of all submodules
dist-head: checkout-head
	$(eval DIST_FILE := $(COMPONENT)-${COMPONENT_VERSION}~$$$${BUILD_NUMBER:-1})
	$(Q)git-archive-all --prefix=$(DIST_FILE)/ $(DIST_FILE).tgz
	$(Q)mv $(DIST_FILE).tgz $(DIST_FILE).tar.gz

dist:
	$(eval GIT_TAG := $(shell git describe --abbrev=0 --match "release/*"))
	$(eval GIT_VER := $(shell x="$(GIT_TAG)"; echo "$${x#release/}"))
	$(if $(subst $(GIT_VER),,$(COMPONENT_VERSION)), $(error Component Version "$(COMPONENT_VERSION)" and GIT tag version "$(GIT_VER)" do not match))
	$(eval DIST_FILE := $(COMPONENT)-${GIT_VER})
	$(Q)git-archive-all --force-submodules --prefix=$(DIST_FILE)/ $(DIST_FILE).tgz
	$(Q)mv $(DIST_FILE).tgz $(DIST_FILE).tar.gz
