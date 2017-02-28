-include Makefile-include-nix

########
# Rules
########

ALLTESTS = $(shell find ..  | grep -Z --color=never "_test\.cpp$$" | sed 's/\.cpp/\.o/g' | sed 's/\.\.\//\.\/bin\//g' )

$(BINDIR)/unit_tests: $(ALLTESTS) ./main.cpp
	$(MKDIR) -p $(dir $@)
	$(ECHO) "[CXX] building  $(BINDIR)/unit_tests"
	$(CXX) $(CXXFLAGS) -DZUNIT_NOT_STANDALONE -o $(BINDIR)/unit_tests $(ALLTESTS) ./main.cpp -lpthread -lrt

all: $(BINDIR)/unit_tests

runtests: all
	$(ECHO) "[RUN] running   $(BINDIR)/unit_tests"
	$(BINDIR)/unit_tests

ALLDEPS = $(shell find ..  | grep -Z --color=never "_test\.cpp$$" | sed 's/\.cpp/\.d/g' | sed 's/\.\.\//\.\/bin\//g' )

-include $(ALLDEPS)