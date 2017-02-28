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

#ifndef ZI_ATOMIC_DETAIL_FENCED_BLOCK_MACOS_HPP
#define ZI_ATOMIC_DETAIL_FENCED_BLOCK_MACOS_HPP 1

#ifndef ZI_ATOMIC_FENCED_BLOCK_HPP_INCLUDING
#  error "don't include this file directly, use fenced_block.hpp"
#endif

class fenced_block: non_copyable
{
public:
    fenced_block()
    {
        OSMemoryBarrier();
    }

    ~fenced_block()
    {
        OSMemoryBarrier();
    }
};

#endif
