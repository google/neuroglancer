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

#ifndef ZI_CONCURRENCY_DETAIL_ALL_THREADS_HPP
#define ZI_CONCURRENCY_DETAIL_ALL_THREADS_HPP 1

#include <zi/concurrency/config.hpp>
#include <zi/concurrency/thread.hpp>

#include <cstddef>

namespace zi {

namespace concurrency_ {

namespace all_threads {



inline std::size_t finished()
{
    return all_threads_info.finished_count();
}

inline std::size_t started()
{
    return all_threads_info.started_count();
}

inline std::size_t active()
{
    return all_threads_info.active_count();
}

inline void join()
{
    all_threads_info.join_all();
}

inline void join_all()
{
    all_threads_info.join_all();
}



} // namespace all_threads

} // namespace concurrency_

} // namespace zi

#endif

