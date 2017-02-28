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

#include <iostream>
#include <vector>
#include <cstdlib>

#include <zi/system/system.hpp>

int main()
{

    std::cout << "CPU Count   : " << zi::system::cpu_count << "\n\n";

    std::cout << "Memory Size : " << zi::system::memory_size << "\n";
    std::cout << "Memory KB   : " << zi::system::memory_kb << "\n";
    std::cout << "Memory MB   : " << zi::system::memory_mb << "\n";
    std::cout << "Memory GB   : " << zi::system::memory_gb << "\n\n";

    std::cout << "Memory Size : " << zi::system::memory::total() << "\n";
    std::cout << "Memory KB   : " << zi::system::memory::total_kb() << "\n";
    std::cout << "Memory MB   : " << zi::system::memory::total_mb() << "\n";
    std::cout << "Memory GB   : " << zi::system::memory::total_gb() << "\n\n";

    std::cout << "Memory Size : " << zi::system::memory::total<float>() << "\n";
    std::cout << "Memory KB   : " << zi::system::memory::total_kb<float>() << "\n";
    std::cout << "Memory MB   : " << zi::system::memory::total_mb<float>() << "\n";
    std::cout << "Memory GB   : " << zi::system::memory::total_gb<float>() << "\n\n";

    std::cout << "Avail Memory: " << zi::system::memory::available() << "\n";
    std::cout << "Avail KB    : " << zi::system::memory::available_kb() << "\n";
    std::cout << "Avail MB    : " << zi::system::memory::available_mb() << "\n";
    std::cout << "Avail GB    : " << zi::system::memory::available_gb() << "\n\n";

    std::cout << "Avail Memory: " << zi::system::memory::available<float>() << "\n";
    std::cout << "Avail KB    : " << zi::system::memory::available_kb<float>() << "\n";
    std::cout << "Avail MB    : " << zi::system::memory::available_mb<float>() << "\n";
    std::cout << "Avail GB    : " << zi::system::memory::available_gb<float>() << "\n\n";

    std::cout << "Usage Memory: " << zi::system::memory::usage() << "\n";
    std::cout << "Usage KB    : " << zi::system::memory::usage_kb() << "\n";
    std::cout << "Usage MB    : " << zi::system::memory::usage_mb() << "\n";
    std::cout << "Usage GB    : " << zi::system::memory::usage_gb() << "\n\n";

    std::cout << "Usage Memory: " << zi::system::memory::usage<float>() << "\n";
    std::cout << "Usage KB    : " << zi::system::memory::usage_kb<float>() << "\n";
    std::cout << "Usage MB    : " << zi::system::memory::usage_mb<float>() << "\n";
    std::cout << "Usage GB    : " << zi::system::memory::usage_gb<float>() << "\n\n";

    std::cout << "Virt  Memory: " << zi::system::memory::usage( true ) << "\n";
    std::cout << "Virt  KB    : " << zi::system::memory::usage_kb( true ) << "\n";
    std::cout << "Virt  MB    : " << zi::system::memory::usage_mb( true ) << "\n";
    std::cout << "Virt  GB    : " << zi::system::memory::usage_gb( true ) << "\n\n";

    std::cout << "Virt  Memory: " << zi::system::memory::usage<float>( true ) << "\n";
    std::cout << "Virt  KB    : " << zi::system::memory::usage_kb<float>( true ) << "\n";
    std::cout << "Virt  MB    : " << zi::system::memory::usage_mb<float>( true ) << "\n";
    std::cout << "Virt  GB    : " << zi::system::memory::usage_gb<float>( true ) << "\n\n";

    {

        std::vector< int > v( 10000000 );

        std::cout << "Virt  Memory: " << zi::system::memory::usage<float>( true ) << "\n";
        std::cout << "Virt  KB    : " << zi::system::memory::usage_kb<float>( true ) << "\n";
        std::cout << "Virt  MB    : " << zi::system::memory::usage_mb<float>( true ) << "\n";
        std::cout << "Virt  GB    : " << zi::system::memory::usage_gb<float>( true ) << "\n\n";

    }

    std::cout << "Virt  Memory: " << zi::system::memory::usage<float>( true ) << "\n";
    std::cout << "Virt  KB    : " << zi::system::memory::usage_kb<float>( true ) << "\n";
    std::cout << "Virt  MB    : " << zi::system::memory::usage_mb<float>( true ) << "\n";
    std::cout << "Virt  GB    : " << zi::system::memory::usage_gb<float>( true ) << "\n\n";


    std::cout << "Username    : " << zi::system::username << "\n";
    std::cout << "Username    : " << zi::system::get_username() << "\n";

    std::cout << "Hostname    : " << zi::system::hostname << "\n";
    std::cout << "Hostname    : " << zi::system::get_hostname() << "\n";

#if defined( ZI_OS_WINDOWS )
    system( "pause" );
#endif

}
