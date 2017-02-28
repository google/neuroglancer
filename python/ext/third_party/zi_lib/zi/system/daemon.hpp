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

#ifndef ZI_SYSTEM_DAEMON_HPP
#define ZI_SYSTEM_DAEMON_HPP 1

#include <zi/config/config.hpp>

#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <signal.h>
#include <unistd.h>

namespace zi {
namespace system {

#  if defined ( ZI_OS_LINUX )

bool daemonize( bool no_chdir = false, bool no_close = false )
{
    struct sigaction osa, sa;
    int fd, oerrno, osa_ok;
    pid_t newgrp;

    ::sigemptyset(&sa.sa_mask);

    sa.sa_handler = SIG_IGN;
    sa.sa_flags = 0;

    osa_ok = ::sigaction(SIGHUP, &sa, &osa);

    switch ( ::fork() )
    {
    case -1:
        return false;
    case 0:
        break;
    default:
        ::exit(0);
    }

    newgrp = ::setsid();
    oerrno = errno;
    if ( osa_ok != -1 )
    {
        ::sigaction(SIGHUP, &osa, NULL);
    }

    if ( newgrp == -1 )
    {
        errno = oerrno;
        return false;
    }

    if (!no_chdir)
    {
        static_cast<void>(::chdir("/"));
    }

    if ( !no_close && (fd = ::open("/dev/null", O_RDWR, 0)) != -1)
    {
        static_cast<void>(::dup2(fd, STDIN_FILENO));
        static_cast<void>(::dup2(fd, STDOUT_FILENO));
        static_cast<void>(::dup2(fd, STDERR_FILENO));
        if (fd > 2)
        {
            static_cast<void>(::close(fd));
        }
    }

    return true;
}

#  else

bool daemonize( bool no_chdir = false, bool no_close = false )
{
    return false;
}

#  endif

} // namespace system
} // namespace zi

#endif
