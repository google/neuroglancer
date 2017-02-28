//
// Copyright (C) 2010  Aleksandar Zlateski <zlateski@mit.edu>
// ----------------------------------------------------------
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.
//

/*
 * to compile (from this directory):
 *   $ g++ example.cpp example_other.cpp -I../../../ -I../../../external/include/ -lpthread -lrt \
 *     -o ziLogExample
 *
 * You need pthread/rt for the threading library. On different platforms
 * you might not need to link against pthread and rt (e.g. windows)
 *
 * try running the binary with
 *   $ ./ziLogExample -h
 * or
 *   $ ./ziLogExample
 */

// If you don't want the time to be displayed, define ZiLOG_NOTIME
#include <zi/logging.hpp>
#include <zi/concurrency.hpp>
#include <zi/shared_ptr.hpp>

// Initialize ZiLOGGING
// Best to do it in the file containing the main function.
// The argument can be one of the following:
// DEFAULT (INFO + DEBUG go to STDLOG, WARNING + ERROR go to STDERR)
// STDOUT  (everything goes to STDOUT)
// STDERR  (everything goes to STDERR)
// STDLOG  (everything goes to STDLOG)
// FILES   (everything goes to (separate) files )

// can be used as: USE_ZiLOGGING() with no params
// identical macros are: ZiLOGGING( ... ), INIT_ZiLOGGING( ... )
// you can use any of this
USE_ZiLOGGING( STDLOG );


// Define logs using DEFINE_ZiLOG(Name, default on/off [, Description])
// The description is optional.
//
// Note: if you initialize ziArgs, you will have an option of
// enabling/disabling specific logs using -logName or -nologName

DEFINE_ZiLOG( FirstLog,  true  ); // same as DEFINE_ZiLOG( FirstLog )
DEFINE_ZiLOG( SecondLog, false );

// A function in some other file using the same logs
extern void do_some_logging();

// A function in some other file not in the global
// namespace using the same logs
namespace other_namespace {
extern void do_some_logging();
}

// Need some threads to demonstrate thread sefty
// Run with -logProveSafety to test it
DEFINE_ZiLOG( ProveSafety, false );

void prove_safety_thread( int id )
{
    for (int i=0;i<1000;++i)
        ZiLOG( INFO, ProveSafety ) << id << i;
}

int main(int argc, char **argv) {

    // Initialize ZiArguments so that you can customize the logs
    zi::parse_arguments( argc, argv, true );

    // Use the logs like this
    ZiLOG( DEBUG,    FirstLog  ) << "Something" << 1 << 2 << 3.3;
    ZiLOG( INFO,     SecondLog ) << "Something" << 1 << 2 << 3.3;
    ZiLOG( ERROR,    FirstLog  ) << "Why did this happen?";
    ZiLOG( WARNING,  SecondLog ) << "Don't mess with me!";

    // don't worry about newlines, or separating arguments
    // use logs like this, the arguments will be TAB separated
    ZiLOG( DEBUG, FirstLog ) << "One"
                             << "Two"
                             << "Three";

    // Or like this
    ZiLOG_DEBUG( FirstLog )    << "I'm debugging";
    ZiLOG_INFO( SecondLog )    << "And Informing";
    ZiLOG_ERROR( FirstLog )    << "And making errors";
    ZiLOG_WARNING( SecondLog ) << "And warning you!";

    // There is also a default (unnamed) log
    ZiLOG( DEBUG ) << "Default debug";
    ZiLOG_INFO()   << "Default info";

    // You can also use printf!
    //ZiLOG(INFO, FirstLog).printf("%0.5f", 1.23);
    //ZiLOG_INFO(FirstLog).printf("%0.5f", 2.23);

    // Even use it like this!
    //ZiLOG(INFO, FirstLog).printf("%d", 0) << "And More!";

    // And prove thread safety
    zi::task_manager::prioritized tm( 10 );

    for ( int i = 0; i < 5000; ++i )
    {
        tm.insert( zi::run_fn( zi::bind( &prove_safety_thread, i ) ) );
    }

    tm.start();
    tm.join();

    ZiLOG( INFO ) << "All DONE!";

    // You can also use IF_ZiLOG statements for custom stuff
    IF_ZiLOG( FirstLog )
    {
        std::cout << "FirstLog is ON\n";
    }
    else
    {
        std::cout << "FirstLog is OFF\n";
    }

    IF_ZiLOG( SecondLog )
    {
        std::cout << "SecondLog is ON\n";
    }
    else
    {
        std::cout << "SecondLog is OFF\n";
    }

    IF_ZiLOG( ProveSafety )
    {
        std::cout << "ProveSafety is ON\n";
    }
    else
    {
        std::cout << "ProveSafety is OFF\n";
    }

    // Show that we can handle stuff from multiple cpp files
    do_some_logging();

    // And other namespaces
    other_namespace::do_some_logging();

}
